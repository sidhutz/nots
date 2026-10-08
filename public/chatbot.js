(() => {
  const root = document.createElement('div');
  root.className = 'ai-chat-widget';
  root.innerHTML = `
    <button class="ai-chat-launcher" type="button" aria-label="Open Student Hub AI helper" aria-expanded="false" aria-controls="aiChatPanel">
      <span aria-hidden="true">✦</span>
    </button>
    <section class="ai-chat-panel" id="aiChatPanel" role="dialog" aria-label="Student Hub AI helper" hidden>
      <div class="ai-chat-header">
        <span class="ai-chat-avatar" aria-hidden="true">✦</span>
        <div class="ai-chat-heading"><strong>Student Hub helper</strong><span>Website &amp; study help</span></div>
        <button class="ai-chat-close" type="button" aria-label="Close chat">×</button>
      </div>
      <div class="ai-chat-messages" role="log" aria-live="polite" aria-relevant="additions text" tabindex="0"></div>
      <p class="ai-chat-privacy">Replies use Google Gemini. Messages are sent to Google for processing and aren’t saved by Student Hub. Don’t share passwords, OTPs, or private files.</p>
      <div class="ai-chat-suggestions" aria-label="Suggested questions">
        <button type="button">How do I upload notes?</button>
        <button type="button">I need help with Google login</button>
      </div>
      <form class="ai-chat-form">
        <label class="sr-only" for="aiChatInput">Your question</label>
        <textarea id="aiChatInput" rows="1" maxlength="1200" placeholder="Ask a question…" required></textarea>
        <button class="ai-chat-send" type="submit" aria-label="Send question">↑</button>
      </form>
    </section>`;
  document.body.append(root);

  const launcher = root.querySelector('.ai-chat-launcher');
  const panel = root.querySelector('.ai-chat-panel');
  const close = root.querySelector('.ai-chat-close');
  const messages = root.querySelector('.ai-chat-messages');
  const form = root.querySelector('.ai-chat-form');
  const input = root.querySelector('#aiChatInput');
  const send = root.querySelector('.ai-chat-send');
  const suggestions = root.querySelector('.ai-chat-suggestions');
  const history = [];

  function addMessage(role, text) {
    const bubble = document.createElement('div');
    bubble.className = `ai-chat-message ai-chat-message-${role}`;
    bubble.textContent = text;
    messages.append(bubble);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  addMessage('assistant', 'Hi! I can help you use Student Hub or answer a quick study question. What would you like to know?');

  function setOpen(open) {
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    if (open) input.focus();
    else launcher.focus();
  }

  launcher.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) setOpen(false);
  });

  async function ask(question) {
    const text = question.trim();
    if (!text || send.disabled) return;
    addMessage('user', text);
    suggestions.hidden = true;
    input.value = '';
    input.style.height = '';
    send.disabled = true;
    const loading = addMessage('loading', 'Thinking…');
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: history.slice(-8) }),
      });
      const result = await response.json().catch(() => ({}));
      loading.remove();
      if (!response.ok) throw new Error(result.error || 'The AI helper could not answer. Please try again.');
      history.push({ role: 'user', text }, { role: 'model', text: result.answer });
      if (history.length > 8) history.splice(0, history.length - 8);
      addMessage('assistant', result.answer);
    } catch (error) {
      loading.remove();
      addMessage('error', error.message || 'Could not reach the AI helper. Please try again.');
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    ask(input.value);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  suggestions.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (button) ask(button.textContent);
  });
})();
