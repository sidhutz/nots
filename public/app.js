const message = document.querySelector('#message');
const errors = {
  setup: 'Google sign-in is not configured yet. Site owner: add your credentials to the .env file.',
  state: 'This sign-in link expired or could not be verified. Please start again.',
  cancelled: 'Sign-in was cancelled. You can try again whenever you’re ready.',
  login: 'We could not complete sign-in. Please try again.',
  unverified: 'A verified Google email address is required.',
};

const code = new URLSearchParams(location.search).get('error');
if (code && message) {
  message.textContent = errors[code] || errors.login;
  history.replaceState({}, '', location.pathname);
}

const profileForm = document.querySelector('#studentProfileForm');
const uploadForm = document.querySelector('#noteUploadForm');
const logout = document.querySelector('#logout');

if (profileForm && uploadForm && logout) {
  const $ = id => document.getElementById(id);
  const profileState = $('profileState');
  const notesList = $('notesList');
  const notesEmpty = $('notesEmpty');
  const uploadHint = $('uploadHint');
  const noteTitle = $('noteTitle');
  const noteFile = $('noteFile');
  let currentUser = null;

  const formatDate = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const formatBytes = value => {
    if (!Number.isFinite(value)) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
  };

  function setMessage(text, tone = 'warning') {
    message.textContent = text || '';
    message.dataset.tone = tone;
  }

  function clearMessage() {
    setMessage('');
    delete message.dataset.tone;
  }

  const textNoteForm = $('textNoteForm');
  const textNoteHint = $('textNoteHint');
  const textNoteTitle = $('textNoteTitle');
  const textNoteContent = $('textNoteContent');
  const textNotesList = $('textNotesList');
  const textNotesEmpty = $('textNotesEmpty');
  const autosaveStatus = $('autosaveStatus');
  const noteSearch = $('noteSearch');
  const noteTypeFilter = $('noteTypeFilter');
  const noteDateFilter = $('noteDateFilter');
  const noteSort = $('noteSort');
  const noteLibraries = [...document.querySelectorAll('.note-library')];
  let allFileNotes = [];
  let allTextNotes = [];
  let currentTextNoteId = null;
  let autosaveTimer = null;
  let autosaveInFlight = false;
  let reminderTimer = null;

  const todoForm = $('todoForm');
  const todoHint = $('todoHint');
  const todoText = $('todoText');
  const todosList = $('todosList');
  const todosEmpty = $('todosEmpty');
  const publicPostForm = $('publicPostForm');
  const publicPostTitle = $('publicPostTitle');
  const publicPostContent = $('publicPostContent');
  const publicPostAttachment = $('publicPostAttachment');
  const publishPostButton = $('publishPost');
  const feedList = $('feedList');
  const feedEmpty = $('feedEmpty');
  const feedStatus = $('feedStatus');
  const feedPostsById = new Map();
  const menuToggle = $('menuToggle');
  const dashboardMenu = $('dashboardMenu');
  const dashboardGrid = $('workspaceGrid');
  const dashboardViews = [...document.querySelectorAll('[data-dashboard-view]')];

  function showDashboardView(viewName) {
    const hasView = dashboardViews.some(view => view.dataset.dashboardView === viewName);
    if (!hasView) return;
    for (const view of dashboardViews) view.dataset.viewActive = String(view.dataset.dashboardView === viewName);
    dashboardGrid.hidden = ![...dashboardGrid.querySelectorAll(':scope > [data-dashboard-view]')]
      .some(view => view.dataset.dashboardView === viewName);
    for (const button of dashboardMenu.querySelectorAll('[data-view-target]')) {
      if (button.dataset.viewTarget === viewName) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    const activeButton = dashboardMenu.querySelector(`[data-view-target="${viewName}"]`);
    $('currentViewTitle').textContent = activeButton?.textContent.trim() || 'Study feed';
    dashboardMenu.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  menuToggle.addEventListener('click', () => {
    dashboardMenu.hidden = !dashboardMenu.hidden;
    menuToggle.setAttribute('aria-expanded', String(!dashboardMenu.hidden));
  });
  dashboardMenu.addEventListener('click', event => {
    const button = event.target.closest('[data-view-target]');
    if (button) showDashboardView(button.dataset.viewTarget);
  });
  document.addEventListener('click', event => {
    if (!dashboardMenu.hidden && !dashboardMenu.contains(event.target) && !menuToggle.contains(event.target)) {
      dashboardMenu.hidden = true;
      menuToggle.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !dashboardMenu.hidden) {
      dashboardMenu.hidden = true;
      menuToggle.setAttribute('aria-expanded', 'false');
      menuToggle.focus();
    }
  });
  showDashboardView('feed');

  function renderUser(user) {
    currentUser = user;
    $('avatar').textContent = (user.full_name || user.contact_email || user.google_email || '?').slice(0, 1).toUpperCase();
    $('heroName').textContent = user.full_name || user.google_name || 'Student';
    $('heroEmail').textContent = user.contact_email || user.google_email || '';
    $('googleEmail').textContent = user.google_email;
    $('verified').textContent = user.email_verified ? 'Verified by Google' : 'Not verified';
    $('created').textContent = formatDate(user.created_at);
    $('last').textContent = formatDate(user.last_login);
    $('fullName').value = user.full_name || user.google_name || '';
    $('contactEmail').value = user.contact_email || user.google_email || '';
    $('role').value = user.role || 'Student';
    profileState.textContent = user.profile_completed
      ? 'Student profile saved. Only your signed-in account can see its notes and todos.'
      : 'Save your full name and email once, then you can upload notes, write study notes, and create todos.';
    uploadForm.querySelector('button').disabled = !user.profile_completed;
    noteFile.disabled = !user.profile_completed;
    noteTitle.disabled = !user.profile_completed;
    uploadHint.textContent = user.profile_completed
      ? 'Upload PDF, images, DOCX, TXT or other note files up to 10 MB.'
      : 'Save the student profile first. After that, note uploads unlock.';

    if (textNoteForm) {
      textNoteForm.querySelector('button').disabled = !user.profile_completed;
      textNoteTitle.disabled = !user.profile_completed;
      textNoteContent.disabled = !user.profile_completed;
      textNoteHint.textContent = user.profile_completed
        ? 'Write and save personal study notes directly to your account.'
        : 'Save the student profile first to write personal notes.';
    }

    if (todoForm) {
      todoForm.querySelector('button').disabled = !user.profile_completed;
      todoText.disabled = !user.profile_completed;
      todoHint.textContent = user.profile_completed
        ? 'Keep track of your study tasks and homework.'
        : 'Save the student profile first to create todo items.';
    }

    if (publicPostForm) {
      publicPostTitle.disabled = !user.profile_completed;
      publicPostContent.disabled = !user.profile_completed;
      publicPostAttachment.disabled = !user.profile_completed;
      publishPostButton.disabled = !user.profile_completed;
      if (!user.profile_completed) feedStatus.textContent = 'Complete your student profile from the menu before sharing a public note.';
    }
  }

  async function loadUser() {
    const response = await fetch('/api/me');
    if (response.status === 401) {
      location.replace('/');
      return;
    }
    if (!response.ok) throw Error('profile');
    const data = await response.json();
    renderUser(data.user);
  }

  async function loadNotes() {
    const response = await fetch('/api/notes');
    if (!response.ok) throw Error('notes');
    const data = await response.json();
    allFileNotes = data.notes || [];
    renderNotes();
  }

  function filteredNotes(notes, kind) {
    const query = noteSearch.value.trim().toLocaleLowerCase();
    const days = Number(noteDateFilter.value || 0);
    const oldest = days ? Date.now() - days * 86400000 : 0;
    const filtered = notes.filter(note => {
      const text = `${note.title || ''} ${note.originalName || ''} ${note.content || ''}`.toLocaleLowerCase();
      return (!query || text.includes(query)) && (!oldest || new Date(note.createdAt).getTime() >= oldest);
    });
    filtered.sort((a, b) => {
      if (noteSort.value === 'title') return String(a.title).localeCompare(String(b.title));
      const delta = new Date(a.createdAt) - new Date(b.createdAt);
      return noteSort.value === 'oldest' ? delta : -delta;
    });
    return filtered;
  }

  function renderNotes() {
    const showFiles = noteTypeFilter.value !== 'written';
    const showWritten = noteTypeFilter.value !== 'file';
    noteLibraries[0].hidden = !showWritten;
    noteLibraries[1].hidden = !showFiles;
    notesList.innerHTML = '';
    const notes = filteredNotes(allFileNotes, 'file');
    notesEmpty.hidden = notes.length > 0;
    if (!notes.length && allFileNotes.length) notesEmpty.textContent = 'No uploaded files match these filters.';
    else notesEmpty.textContent = 'No notes yet. Save your student profile, then upload your first file.';
    for (const note of notes) {
      const card = document.createElement('article');
      card.className = 'note-card';
      const canPreview = note.mimeType === 'application/pdf' || /^image\/(png|jpeg|gif|webp)$/.test(note.mimeType || '');
      card.innerHTML = `
        <div class="note-copy">
          <h3>${escapeHtml(note.title)}</h3>
          <p>${escapeHtml(note.originalName)}</p>
          <div class="note-meta">${formatBytes(note.sizeBytes)} · Uploaded ${formatDate(note.createdAt)}</div>
        </div>
        <div class="note-actions">
          ${canPreview ? `<button class="secondary" type="button" data-preview-url="${note.previewUrl}" data-preview-type="${escapeHtml(note.mimeType)}" data-preview-name="${escapeHtml(note.title)}">Preview</button>` : ''}
          <a class="secondary link-button" href="${note.downloadUrl}">Download</a>
          <button class="ghost danger" type="button" data-note-id="${note.id}">Delete</button>
        </div>`;
      notesList.append(card);
    }
  }

  async function loadTextNotes() {
    if (!textNotesList) return;
    const response = await fetch('/api/text-notes');
    if (!response.ok) throw Error('text-notes');
    const data = await response.json();
    allTextNotes = data.textNotes || [];
    renderTextNotes();
  }

  function renderTextNotes() {
    textNotesList.innerHTML = '';
    const notes = filteredNotes(allTextNotes, 'written');
    textNotesEmpty.hidden = notes.length > 0;
    if (!notes.length && allTextNotes.length) textNotesEmpty.textContent = 'No written notes match these filters.';
    else textNotesEmpty.textContent = 'No personal notes written yet. Write and save your first note above.';
    for (const note of notes) {
      const card = document.createElement('article');
      card.className = 'note-card text-note-card';
      card.innerHTML = `
        <div class="note-copy">
          <h3>${escapeHtml(note.title)}</h3>
          <div class="text-note-body">${escapeHtml(note.content)}</div>
          <div class="note-meta">Created ${formatDate(note.createdAt)}</div>
        </div>
        <div class="note-actions">
          <button class="secondary" type="button" data-edit-text-note="${note.id}">Edit</button>
          <button class="ghost danger" type="button" data-text-note-id="${note.id}">Delete</button>
        </div>`;
      textNotesList.append(card);
    }
  }

  async function loadTodos() {
    if (!todosList) return;
    const response = await fetch('/api/todos');
    if (!response.ok) throw Error('todos');
    const data = await response.json();
    todosList.innerHTML = '';
    const todos = data.todos || [];
    window.currentTodos = todos;
    todos.sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      if (!a.dueAt) return b.dueAt ? 1 : 0;
      if (!b.dueAt) return -1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });
    todosEmpty.hidden = todos.length > 0;
    for (const todo of todos) {
      const localDueAt = todo.dueAt ? new Date(todo.dueAt) : null;
      const localDueValue = localDueAt && !Number.isNaN(localDueAt.getTime())
        ? new Date(localDueAt.getTime() - localDueAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
        : '';
      const item = document.createElement('div');
      const overdue = todo.dueAt && !todo.completed && new Date(todo.dueAt) < new Date();
      item.className = `todo-item ${todo.completed ? 'completed' : ''} ${overdue ? 'overdue' : ''}`;
      item.innerHTML = `
        <label class="todo-label">
          <input type="checkbox" class="todo-checkbox" data-todo-toggle="${todo.id}" ${todo.completed ? 'checked' : ''}>
          <span class="todo-text">${escapeHtml(todo.text)}</span>
        </label>
        <div class="todo-detail">${todo.dueAt ? `<time datetime="${escapeHtml(todo.dueAt)}">Due ${formatDate(todo.dueAt)}</time>` : '<span>No due date</span>'}
          <label class="reschedule-label">Change due<input type="datetime-local" data-todo-due="${todo.id}" value="${localDueValue}"></label>
        </div>
        <button class="ghost danger" type="button" data-todo-id="${todo.id}">Delete</button>`;
      todosList.append(item);
    }
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function socialAvatar(person) {
    const name = person?.name || 'Student';
    return `<span class="social-avatar">${person?.picture ? `<img src="${escapeHtml(person.picture)}" alt="">` : escapeHtml(name.slice(0, 1).toUpperCase())}</span>`;
  }

  function renderPeople(people) {
    if (!people.length) return '<p class="small">Nobody yet.</p>';
    return `<ul class="social-name-list">${people.map(item => {
      const person = item.user || item;
      return `<li>${socialAvatar(person)}<span>${escapeHtml(person.name || 'Student')}</span></li>`;
    }).join('')}</ul>`;
  }

  function renderComments(comments) {
    if (!comments.length) return '<p class="small">No comments yet. Start the conversation.</p>';
    return comments.map(comment => `<article class="social-comment">${socialAvatar(comment.author)}<div><strong>${escapeHtml(comment.author?.name || 'Student')}</strong><p>${escapeHtml(comment.content)}</p></div></article>`).join('');
  }

  function renderFeed(posts) {
    feedPostsById.clear();
    feedEmpty.hidden = posts.length > 0;
    feedList.innerHTML = posts.map(post => {
      feedPostsById.set(String(post.id), post);
      const isOwner = currentUser && String(currentUser.id) === String(post.authorId);
      const attachment = post.attachment ? (post.attachment.isImage
        ? `<a class="post-attachment-image" href="${escapeHtml(post.attachment.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(post.attachment.url)}" alt="Attachment: ${escapeHtml(post.attachment.filename)}" loading="lazy"></a>`
        : `<a class="post-attachment-file" href="${escapeHtml(post.attachment.url)}" download="${escapeHtml(post.attachment.filename)}">📎 ${escapeHtml(post.attachment.filename)} <span>Download</span></a>`)
        : '';
      return `<article class="social-post" data-post-card="${post.id}">
        <div class="social-post-head">${socialAvatar(post.author)}<div class="social-post-author"><strong>${escapeHtml(post.author?.name || 'Student')}</strong><time datetime="${escapeHtml(post.createdAt)}">${formatDate(post.createdAt)}</time></div>
          ${isOwner ? '<button class="social-post-menu" type="button" data-delete-post aria-label="Delete your public note" title="Delete post">⋯</button>' : ''}
        </div>
        <h2>${escapeHtml(post.title)}</h2><p class="social-post-content">${escapeHtml(post.content)}</p>${attachment}
        <div class="social-post-actions">
          <button class="secondary" type="button" data-like-post aria-pressed="${post.likedByMe}">${post.likedByMe ? '♥ Liked' : '♡ Like'}</button>
          <button class="ghost" type="button" data-show-likers>${post.likeCount} ${post.likeCount === 1 ? 'like' : 'likes'}</button>
          <button class="ghost" type="button" data-toggle-comments>${post.commentCount} ${post.commentCount === 1 ? 'comment' : 'comments'}</button>
          <button class="secondary" type="button" data-repost aria-pressed="${post.repostedByMe}">${post.repostedByMe ? '↻ Reposted' : '↻ Repost'}</button>
          <button class="ghost" type="button" data-show-reposters>${post.repostCount} reposts</button>
        </div>
        <div class="social-detail" data-likers-panel hidden></div>
        <div class="social-detail" data-reposters-panel hidden></div>
        <div class="social-detail social-comments-panel" data-comments-panel hidden>
          <div class="social-comments" data-comment-list></div>
          <form class="social-comment-form" data-comment-form>
            <textarea name="content" rows="1" maxlength="1000" required aria-label="Write a comment" placeholder="Write a comment…"></textarea>
            <button class="primary" type="submit">Comment</button>
          </form>
        </div>
      </article>`;
    }).join('');
  }

  async function loadFeed() {
    feedStatus.textContent = 'Loading public study notes…';
    try {
      const response = await fetch('/api/feed');
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not load the public feed.');
      renderFeed(data.posts || []);
      feedStatus.textContent = '';
    } catch (error) {
      feedStatus.textContent = `${error.message || 'Could not load the public feed.'} If this is the first setup, run the public-community Supabase migration.`;
      feedEmpty.hidden = true;
      feedList.replaceChildren();
    }
  }

  async function loadSocialPeople(postId, panel, endpoint, emptyText) {
    panel.hidden = false;
    panel.textContent = 'Loading…';
    try {
      const response = await fetch(`/api/posts/${postId}/${endpoint}`);
      const data = await response.json();
      if (!response.ok) throw Error(data.error || `Could not load ${endpoint}.`);
      const people = data[endpoint] || [];
      panel.innerHTML = people.length ? renderPeople(people) : `<p class="small">${emptyText}</p>`;
    } catch (error) {
      panel.textContent = error.message || `Could not load ${endpoint}.`;
    }
  }

  async function loadPostComments(postId, panel, { silent = false } = {}) {
    if (panel.dataset.loading === 'true') return;
    const list = panel.querySelector('[data-comment-list]');
    panel.dataset.loading = 'true';
    if (!silent) list.textContent = 'Loading comments…';
    try {
      const response = await fetch(`/api/posts/${postId}/comments`);
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not load comments.');
      const comments = data.comments || [];
      list.innerHTML = renderComments(comments);
      panel.dataset.loaded = 'true';
      const post = feedPostsById.get(String(postId));
      if (post) {
        post.commentCount = comments.length;
        const button = panel.closest('[data-post-card]')?.querySelector('[data-toggle-comments]');
        if (button) button.textContent = `${post.commentCount} ${post.commentCount === 1 ? 'comment' : 'comments'}`;
      }
    } catch (error) {
      if (!silent || panel.dataset.loaded !== 'true') list.textContent = error.message || 'Could not load comments.';
    } finally {
      delete panel.dataset.loading;
    }
  }

  function refreshOpenComments() {
    if (document.visibilityState !== 'visible' || $('communityFeed').dataset.viewActive !== 'true') return;
    for (const panel of feedList.querySelectorAll('[data-comments-panel]:not([hidden])')) {
      const card = panel.closest('[data-post-card]');
      if (card) void loadPostComments(card.dataset.postCard, panel, { silent: true });
    }
  }
  setInterval(refreshOpenComments, 12000);
  document.addEventListener('visibilitychange', refreshOpenComments);
  window.addEventListener('focus', refreshOpenComments);

  feedList.addEventListener('click', async event => {
    const card = event.target.closest('[data-post-card]');
    if (!card) return;
    const postId = card.dataset.postCard;
    const post = feedPostsById.get(String(postId));
    if (!post) return;
    const likerButton = event.target.closest('[data-show-likers]');
    if (likerButton) {
      const panel = card.querySelector('[data-likers-panel]');
      if (panel.hidden) await loadSocialPeople(postId, panel, 'likes', 'No likes yet.');
      else panel.hidden = true;
      return;
    }
    const repostersButton = event.target.closest('[data-show-reposters]');
    if (repostersButton) {
      const panel = card.querySelector('[data-reposters-panel]');
      if (panel.hidden) await loadSocialPeople(postId, panel, 'reposts', 'Nobody has reposted this note yet.');
      else panel.hidden = true;
      return;
    }
    const commentsButton = event.target.closest('[data-toggle-comments]');
    if (commentsButton) {
      const panel = card.querySelector('[data-comments-panel]');
      panel.hidden = !panel.hidden;
      if (!panel.hidden) await loadPostComments(postId, panel);
      return;
    }
    const likeButton = event.target.closest('[data-like-post]');
    if (likeButton) {
      likeButton.disabled = true;
      try {
        const response = await fetch(`/api/posts/${postId}/likes`, { method: post.likedByMe ? 'DELETE' : 'POST' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Could not update like.');
        post.likedByMe = !post.likedByMe;
        post.likeCount = Math.max(0, post.likeCount + (post.likedByMe ? 1 : -1));
        renderFeed([...feedPostsById.values()]);
      } catch (error) { feedStatus.textContent = error.message || 'Could not update like.'; likeButton.disabled = false; }
      return;
    }
    const repostButton = event.target.closest('[data-repost]');
    if (repostButton) {
      repostButton.disabled = true;
      try {
        const response = await fetch(`/api/posts/${postId}/reposts`, { method: post.repostedByMe ? 'DELETE' : 'POST' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Could not update repost.');
        post.repostedByMe = !post.repostedByMe;
        post.repostCount = Math.max(0, post.repostCount + (post.repostedByMe ? 1 : -1));
        renderFeed([...feedPostsById.values()]);
      } catch (error) { feedStatus.textContent = error.message || 'Could not update repost.'; repostButton.disabled = false; }
      return;
    }
    const deleteButton = event.target.closest('[data-delete-post]');
    if (deleteButton) {
      if (!window.confirm('Delete this public note? Its likes, comments and reposts will also be removed.')) return;
      deleteButton.disabled = true;
      try {
        const response = await fetch(`/api/posts/${postId}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Could not delete the post.');
        renderFeed([...feedPostsById.values()].filter(item => String(item.id) !== String(postId)));
      } catch (error) { feedStatus.textContent = error.message || 'Could not delete the post.'; deleteButton.disabled = false; }
    }
  });

  feedList.addEventListener('submit', async event => {
    const form = event.target.closest('[data-comment-form]');
    if (!form) return;
    event.preventDefault();
    const card = form.closest('[data-post-card]');
    const post = feedPostsById.get(String(card.dataset.postCard));
    const textarea = form.elements.content;
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const response = await fetch(`/api/posts/${card.dataset.postCard}/comments`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: textarea.value }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not add the comment.');
      textarea.value = '';
      post.commentCount += 1;
      card.querySelector('[data-toggle-comments]').textContent = `${post.commentCount} ${post.commentCount === 1 ? 'comment' : 'comments'}`;
      await loadPostComments(card.dataset.postCard, card.querySelector('[data-comments-panel]'));
    } catch (error) { feedStatus.textContent = error.message || 'Could not add the comment.'; }
    finally { button.disabled = false; }
  });

  $('refreshFeed')?.addEventListener('click', loadFeed);
  publicPostForm?.addEventListener('submit', async event => {
    event.preventDefault();
    publishPostButton.disabled = true;
    feedStatus.textContent = 'Sharing your note…';
    try {
      const body = new FormData();
      body.set('title', publicPostTitle.value);
      body.set('content', publicPostContent.value);
      if (publicPostAttachment.files[0]) body.set('attachment', publicPostAttachment.files[0]);
      const response = await fetch('/api/posts', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not share your note.');
      publicPostForm.reset();
      publicPostAttachment.value = '';
      feedStatus.textContent = 'Your public study note has been shared.';
      await loadFeed();
    } catch (error) { feedStatus.textContent = error.message || 'Could not share your note.'; }
    finally { publishPostButton.disabled = !currentUser?.profile_completed; }
  });

  function setAutosaveLabel(text, tone = '') {
    if (!autosaveStatus) return;
    autosaveStatus.textContent = text;
    autosaveStatus.dataset.tone = tone;
  }

  function rememberDraft() {
    if (!currentUser) return;
    const draftKey = `student-notes-draft:${currentUser.id}`;
    const draft = { title: textNoteTitle.value, content: textNoteContent.value, noteId: currentTextNoteId, savedAt: new Date().toISOString() };
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
      setAutosaveLabel('Draft saved on this device…');
    } catch {
      setAutosaveLabel('Device draft storage is unavailable; trying to save to your account…', 'warning');
    }
  }

  async function saveTextNoteNow() {
    if (autosaveInFlight) return;
    const title = textNoteTitle.value.trim();
    const content = textNoteContent.value.trim();
    if (!title || !content) {
      setAutosaveLabel('Add a title and some text to save to your account.');
      return;
    }
    autosaveInFlight = true;
    setAutosaveLabel('Saving to your account…');
    try {
      const response = await fetch(currentTextNoteId ? `/api/text-notes/${currentTextNoteId}` : '/api/text-notes', {
        method: currentTextNoteId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Autosave failed.');
      currentTextNoteId = data.textNote.id;
      if (currentUser) localStorage.removeItem(`student-notes-draft:${currentUser.id}`);
      setAutosaveLabel(`Saved to your account · ${formatDate(data.textNote.updatedAt || data.textNote.createdAt)}`, 'success');
      await loadTextNotes();
      if (textNoteTitle.value.trim() !== title || textNoteContent.value.trim() !== content) scheduleAutosave(250);
    } catch (error) {
      setAutosaveLabel(`${error.message || 'Autosave failed.'} Your latest draft is still on this device.`, 'warning');
    } finally {
      autosaveInFlight = false;
    }
  }

  function scheduleAutosave(delay = 800) {
    rememberDraft();
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveTextNoteNow, delay);
  }

  function applyNoteFilters() {
    renderTextNotes();
    renderNotes();
  }

  for (const control of [noteSearch, noteTypeFilter, noteDateFilter, noteSort]) {
    control?.addEventListener(control === noteSearch ? 'input' : 'change', applyNoteFilters);
  }

  $('themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('student-notes-theme', next);
    $('themeToggle').textContent = next === 'dark' ? 'Light mode' : 'Dark mode';
    $('themeToggle').setAttribute('aria-pressed', String(next === 'dark'));
  });

  const savedTheme = localStorage.getItem('student-notes-theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  if ($('themeToggle')) {
    $('themeToggle').textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode';
    $('themeToggle').setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
  }

  $('printNotes')?.addEventListener('click', () => {
    $('printDate').textContent = `Exported ${new Date().toLocaleString()}`;
    window.print();
  });

  $('closePreview')?.addEventListener('click', () => $('filePreviewDialog').close());
  $('filePreviewDialog')?.addEventListener('close', () => $('previewContent').replaceChildren());

  $('enableReminders')?.addEventListener('click', async () => {
    if (!('Notification' in window)) {
      $('reminderStatus').textContent = 'This browser does not support notifications.';
      return;
    }
    const permission = await Notification.requestPermission();
    $('reminderStatus').textContent = permission === 'granted'
      ? 'Reminders enabled while this dashboard stays open.'
      : 'Notifications are off. You can still see due dates in your task list.';
    if (permission === 'granted') checkDueReminders();
  });

  function checkDueReminders() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    let rememberedIds = [];
    try {
      const saved = JSON.parse(sessionStorage.getItem('reminded-todos') || '[]');
      if (Array.isArray(saved)) rememberedIds = saved;
    } catch {
      sessionStorage.removeItem('reminded-todos');
    }
    const reminded = new Set(rememberedIds);
    for (const todo of window.currentTodos || []) {
      if (!todo.completed && todo.dueAt && new Date(todo.dueAt) <= new Date() && !reminded.has(String(todo.id))) {
        new Notification('Study task due', { body: todo.text, tag: `todo-${todo.id}` });
        reminded.add(String(todo.id));
      }
    }
    sessionStorage.setItem('reminded-todos', JSON.stringify([...reminded]));
  }

  $('exportData')?.addEventListener('click', async () => {
    const button = $('exportData');
    button.disabled = true;
    try {
      const response = await fetch('/api/account/export');
      if (!response.ok) throw Error('Could not export your account data.');
      const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      const exportUrl = URL.createObjectURL(blob);
      link.href = exportUrl;
      link.download = 'student-hub-data.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(exportUrl), 1000);
      setMessage('Your account data export is ready.', 'success');
    } catch (error) {
      setMessage(error.message || 'Export failed.');
    } finally { button.disabled = false; }
  });

  $('deleteAccount')?.addEventListener('click', () => {
    $('deleteAccountConfirmation').value = '';
    $('deleteAccountDialog').showModal();
  });

  $('deleteAccountForm')?.addEventListener('submit', async event => {
    if (event.submitter?.value !== 'confirm') return;
    event.preventDefault();
    if ($('deleteAccountConfirmation').value !== 'DELETE') {
      setMessage('Type DELETE exactly to confirm account removal.');
      return;
    }
    const button = $('confirmDeleteAccount');
    button.disabled = true;
    try {
      const response = await fetch('/api/account', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE' }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Account deletion failed.');
      localStorage.removeItem(`student-notes-draft:${currentUser.id}`);
      location.replace('/?accountDeleted=1');
    } catch (error) {
      setMessage(error.message || 'Account deletion failed.');
      $('deleteAccountDialog').close();
      button.disabled = false;
    }
  });

  notesList.addEventListener('click', async event => {
    const preview = event.target.closest('button[data-preview-url]');
    if (preview) {
      const content = $('previewContent');
      content.replaceChildren();
      $('previewTitle').textContent = `Preview · ${preview.dataset.previewName}`;
      const element = document.createElement(preview.dataset.previewType === 'application/pdf' ? 'iframe' : 'img');
      element.src = preview.dataset.previewUrl;
      element.title = preview.dataset.previewName;
      if (element.tagName === 'IMG') element.alt = preview.dataset.previewName;
      content.append(element);
      $('filePreviewDialog').showModal();
      return;
    }
    const button = event.target.closest('button[data-note-id]');
    if (!button) return;
    button.disabled = true;
    clearMessage();
    try {
      const response = await fetch(`/api/notes/${button.dataset.noteId}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Delete failed.');
      await loadNotes();
      setMessage('Note deleted.', 'success');
    } catch (error) {
      setMessage(error.message || 'Delete failed.');
      button.disabled = false;
    }
  });

  if (textNotesList) {
    textNotesList.addEventListener('click', async event => {
      const edit = event.target.closest('button[data-edit-text-note]');
      if (edit) {
        const note = allTextNotes.find(item => String(item.id) === edit.dataset.editTextNote);
        if (!note) return;
        clearTimeout(autosaveTimer);
        currentTextNoteId = note.id;
        textNoteTitle.value = note.title;
        textNoteContent.value = note.content;
        setAutosaveLabel(`Editing note · last saved ${formatDate(note.updatedAt || note.createdAt)}`);
        textNoteForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        textNoteTitle.focus();
        return;
      }
      const button = event.target.closest('button[data-text-note-id]');
      if (!button) return;
      button.disabled = true;
      clearMessage();
      try {
        const response = await fetch(`/api/text-notes/${button.dataset.textNoteId}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Delete failed.');
        await loadTextNotes();
        if (String(currentTextNoteId) === button.dataset.textNoteId) {
          currentTextNoteId = null;
          textNoteForm.reset();
          setAutosaveLabel('Deleted note. Start a new note whenever you are ready.');
        }
        setMessage('Personal note deleted.', 'success');
      } catch (error) {
        setMessage(error.message || 'Delete failed.');
        button.disabled = false;
      }
    });
  }

  if (todosList) {
    todosList.addEventListener('change', async event => {
      const dueInput = event.target.closest('input[data-todo-due]');
      if (dueInput) {
        dueInput.disabled = true;
        try {
          const response = await fetch(`/api/todos/${dueInput.dataset.todoDue}`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dueAt: dueInput.value ? new Date(dueInput.value).toISOString() : null }),
          });
          const data = await response.json();
          if (!response.ok) throw Error(data.error || 'Could not update due date.');
          await loadTodos();
          setMessage('Reminder due date updated.', 'success');
        } catch (error) {
          setMessage(error.message || 'Could not update due date.');
          dueInput.disabled = false;
        }
        return;
      }
      const checkbox = event.target.closest('input[data-todo-toggle]');
      if (!checkbox) return;
      clearMessage();
      checkbox.disabled = true;
      try {
        const response = await fetch(`/api/todos/${checkbox.dataset.todoToggle}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ completed: checkbox.checked }),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Update failed.');
        await loadTodos();
      } catch (error) {
        setMessage(error.message || 'Failed to update todo.');
        checkbox.checked = !checkbox.checked;
        checkbox.disabled = false;
      }
    });

    todosList.addEventListener('click', async event => {
      const button = event.target.closest('button[data-todo-id]');
      if (!button) return;
      button.disabled = true;
      clearMessage();
      try {
        const response = await fetch(`/api/todos/${button.dataset.todoId}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Delete failed.');
        await loadTodos();
        setMessage('Todo item deleted.', 'success');
      } catch (error) {
        setMessage(error.message || 'Delete failed.');
        button.disabled = false;
      }
    });
  }

  profileForm.addEventListener('submit', async event => {
    event.preventDefault();
    clearMessage();
    const save = $('saveProfile');
    save.disabled = true;
    profileState.textContent = 'Saving…';
    try {
      const response = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: $('fullName').value,
          contactEmail: $('contactEmail').value,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Could not save profile.');
      renderUser(data.user);
      setMessage('Student profile saved.', 'success');
    } catch (error) {
      profileState.textContent = 'Could not save your student profile.';
      setMessage(error.message || 'Could not save profile.');
    } finally {
      save.disabled = false;
    }
  });

  uploadForm.addEventListener('submit', async event => {
    event.preventDefault();
    clearMessage();
    const submit = $('uploadNote');
    submit.disabled = true;
    try {
      const body = new FormData(uploadForm);
      const response = await fetch('/api/notes/upload', { method: 'POST', body });
      const data = await response.json();
      if (!response.ok) throw Error(data.error || 'Upload failed.');
      uploadForm.reset();
      await loadNotes();
      setMessage('Note uploaded. Only this signed-in student account can access it.', 'success');
    } catch (error) {
      setMessage(error.message || 'Upload failed.');
    } finally {
      submit.disabled = false;
    }
  });

  if (textNoteForm) {
    textNoteForm.addEventListener('input', event => {
      if (event.target === textNoteTitle || event.target === textNoteContent) scheduleAutosave();
    });
    textNoteForm.addEventListener('submit', async event => {
      event.preventDefault();
      clearTimeout(autosaveTimer);
      await saveTextNoteNow();
    });
    $('newTextNote').addEventListener('click', () => {
      clearTimeout(autosaveTimer);
      currentTextNoteId = null;
      textNoteForm.reset();
      if (currentUser) localStorage.removeItem(`student-notes-draft:${currentUser.id}`);
      setAutosaveLabel('New note · changes save automatically.');
      textNoteTitle.focus();
    });
  }

  if (todoForm) {
    todoForm.addEventListener('submit', async event => {
      event.preventDefault();
      clearMessage();
      const submit = $('addTodo');
      submit.disabled = true;
      try {
        const response = await fetch('/api/todos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: todoText.value,
            dueAt: $('todoDueAt').value ? new Date($('todoDueAt').value).toISOString() : null,
          }),
        });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || 'Failed to add todo.');
        todoForm.reset();
        await loadTodos();
        setMessage('Todo item added.', 'success');
      } catch (error) {
        setMessage(error.message || 'Failed to add todo.');
      } finally {
        submit.disabled = false;
      }
    });
  }

  logout.addEventListener('click', async () => {
    logout.disabled = true;
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (!response.ok) throw Error();
      location.replace('/');
    } catch {
      setMessage('Sign-out failed. Please try again.');
      logout.disabled = false;
    }
  });

  (async () => {
    try {
      await loadUser();
      await loadNotes();
      await loadTextNotes();
      await loadTodos();
      await loadFeed();
      if (reminderTimer) clearInterval(reminderTimer);
      reminderTimer = setInterval(checkDueReminders, 30000);
      checkDueReminders();
      if (currentUser) {
        const draft = localStorage.getItem(`student-notes-draft:${currentUser.id}`);
        if (draft && !textNoteTitle.value && !textNoteContent.value) {
          try {
            const savedDraft = JSON.parse(draft);
            currentTextNoteId = savedDraft.noteId || null;
            textNoteTitle.value = savedDraft.title || '';
            textNoteContent.value = savedDraft.content || '';
            setAutosaveLabel('Restored an unsaved draft from this device.');
          } catch { localStorage.removeItem(`student-notes-draft:${currentUser.id}`); }
        }
      }
    } catch {
      setMessage('Unable to load your dashboard. Please refresh the page.');
    }
  })();
}
