const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({markdownit: require('../src/docx_knowledge_graph/static/vendor/markdown-it.min.js')});
vm.runInContext(readFileSync(join(__dirname, '../src/docx_knowledge_graph/static/chat-markdown.js'), 'utf8'), context);
const render = vm.runInContext('renderChatMarkdown', context);

test('renders professional Markdown with nested lists and comparisons', () => {
  const html = render('## Findings\n\n**Key** and *detail*.\n\n1. First\n   - Nested\n2. Second\n\n> Evidence\n\n| Item | Count |\n| --- | ---: |\n| Alpha | 3 |');
  for (const tag of ['<h2>', '<strong>', '<em>', '<ol>', '<ul>', '<blockquote>', '<table>', '<thead>', '<tbody>']) assert.ok(html.includes(tag), tag);
  assert.match(html, /class="chat-table-wrap"[^>]+tabindex="0"/);
});

test('escapes raw HTML, script handlers and source text', () => {
  const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<svg onload=alert(1)>\n\n<iframe srcdoc="bad">');
  assert.doesNotMatch(html, /<(script|img|svg|iframe)\b/i);
  assert.match(html, /&lt;script&gt;/);
});

test('rejects executable, obfuscated, data and local URLs', () => {
  for (const url of ['javascript:alert(1)', 'java&#x73;cript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,bad', 'file:///etc/passwd', '//evil.example/path', '/api/chat/reset', '#chat-close']) {
    assert.doesNotMatch(render(`[Click](${url})`), /<a\b/, url);
  }
});

test('opens allowed external links separately without an opener or referrer', () => {
  const html = render('[Reference](https://example.com "Read this")');
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('never loads remote images, including image references', () => {
  const html = render('![private text](https://example.com/pixel)\n\n![More][image]\n\n[image]: https://example.com/other');
  assert.doesNotMatch(html, /<img\b|src=/);
  assert.match(html, /\[Image: private text\]/);
});

test('preserves citations and fenced code as text for DOM-aware resolution', () => {
  const html = render('**Finding** [node:passage-1]\n\n`[node:passage-1]`\n\n```graphquery\nRETURN "<script>"\n[node:passage-1]\n```');
  assert.match(html, /<strong>Finding<\/strong> \[node:passage-1\]/);
  assert.match(html, /<code>\[node:passage-1\]<\/code>/);
  assert.match(html, /language-graphquery/);
  assert.match(html, /&lt;script&gt;/);
});

test('handles incomplete streamed syntax without executing markup', () => {
  const markdown = '## Findings\n\n**Answer** [node:passage-1]\n\n```json\n{"unsafe":"<img src=x onerror=alert(1)>"}\n```';
  for (let length = 1; length <= markdown.length; length++) {
    assert.doesNotMatch(render(markdown.slice(0, length)), /<img\b|<script\b/);
  }
  assert.match(render(markdown), /<strong>Answer<\/strong>/);
});
