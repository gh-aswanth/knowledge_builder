class WorkspaceError(ValueError):
    def __init__(self, message: str, code: str = "INVALID_DOCUMENT", status: int = 422):
        super().__init__(message)
        self.code = code
        self.status = status
