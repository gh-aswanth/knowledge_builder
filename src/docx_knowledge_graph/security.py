import secrets

from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"


class RequestGuards:
    def __init__(self, app, token: str, max_upload_bytes: int):
        self.app = app
        self.token = token
        self.max_upload_bytes = max_upload_bytes

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def secure_send(message):
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Content-Security-Policy"] = CSP
                headers["X-Content-Type-Options"] = "nosniff"
                headers["Referrer-Policy"] = "no-referrer"
                headers["Cache-Control"] = "no-store"
            await send(message)

        if scope["method"] != "POST" or not scope["path"].startswith("/api/"):
            await self.app(scope, receive, secure_send)
            return
        headers = Headers(scope=scope)
        origin = headers.get("origin")
        host = headers.get("host", "")
        if (
            not secrets.compare_digest(headers.get("x-workspace-token", ""), self.token)
            or headers.get("sec-fetch-site") == "cross-site"
            or origin
            and origin not in {f"http://{host}", f"https://{host}"}
        ):
            await JSONResponse(
                {
                    "error": {
                        "code": "FORBIDDEN",
                        "message": "Reload this workspace and submit requests from this page.",
                    }
                },
                status_code=403,
            )(scope, receive, secure_send)
            return
        limit = self.max_upload_bytes + 65536 if scope["path"] == "/api/documents" else 64000
        try:
            declared = int(headers.get("content-length", "0"))
        except ValueError:
            declared = -1
        if declared < 0 or declared > limit:
            await JSONResponse(
                {
                    "error": {
                        "code": "REQUEST_TOO_LARGE",
                        "message": "Request exceeds the allowed upload or JSON size.",
                    }
                },
                status_code=413,
            )(scope, receive, secure_send)
            return
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    raise HTTPException(413, "Request exceeds the allowed upload or JSON size.")
            return message

        await self.app(scope, bounded_receive, secure_send)
