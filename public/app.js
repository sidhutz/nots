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
      ? 'Student profile saved. Only your signed-in account can see its notes.'
      : 'Save your full name and email once, then you can upload private notes.';
    uploadForm.querySelector('button').disabled = !user.profile_completed;
    noteFile.disabled = !user.profile_completed;
    noteTitle.disabled = !user.profile_completed;
    uploadHint.textContent = user.profile_completed
      ? 'Upload PDF, images, DOCX, TXT or other note files up to 10 MB.'
      : 'Save the student profile first. After that, note uploads unlock.';
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
    notesList.innerHTML = '';
    const notes = data.notes || [];
    notesEmpty.hidden = notes.length > 0;
    for (const note of notes) {
      const card = document.createElement('article');
      card.className = 'note-card';
      card.innerHTML = `
        <div class="note-copy">
          <h3>${note.title}</h3>
          <p>${note.originalName}</p>
          <div class="note-meta">${formatBytes(note.sizeBytes)} · Uploaded ${formatDate(note.createdAt)}</div>
        </div>
        <div class="note-actions">
          <a class="secondary link-button" href="${note.downloadUrl}">Download</a>
          <button class="ghost danger" type="button" data-note-id="${note.id}">Delete</button>
        </div>`;
      notesList.append(card);
    }
  }

  notesList.addEventListener('click', async event => {
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
    } catch {
      setMessage('Unable to load your dashboard. Please refresh the page.');
    }
  })();
}
