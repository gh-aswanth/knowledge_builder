'use strict';

const chatMarkdown = markdownit({html: false, linkify: false, breaks: false});
chatMarkdown.validateLink = url => /^https?:\/\//i.test(url);
chatMarkdown.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};
chatMarkdown.renderer.rules.image = (tokens, index) =>
  chatMarkdown.utils.escapeHtml(`[Image: ${tokens[index].content || 'not loaded'}]`);
chatMarkdown.renderer.rules.table_open = () =>
  '<div class="chat-table-wrap" role="region" aria-label="Answer table" tabindex="0"><table>';
chatMarkdown.renderer.rules.table_close = () => '</table></div>';

function renderChatMarkdown(text) {
  return chatMarkdown.render(text);
}
