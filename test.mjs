import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from './db.mjs';
import { createHash } from 'node:crypto';

test('Google subject is unique; repeat login updates the same user', () => {
  const s = openStore(':memory:');
  const a = s.upsert({ sub: 'test-sub', email: 'test@example.com', name: 'Test User', email_verified: true });
  const b = s.upsert({ sub: 'test-sub', email: 'updated@example.com', name: 'Updated', email_verified: true });
  assert.equal(a.id, b.id);
  assert.equal(a.created_at, b.created_at);
  assert.equal(b.email, 'updated@example.com');
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  s.db.close();
});

test('Student profile stores full name, contact email and fixed Student role', () => {
  const s = openStore(':memory:');
  const user = s.upsert({ sub: 'student-1', email: 'google@example.com', name: 'Google Name', email_verified: true });
  const updated = s.updateStudentProfile(user.id, { fullName: 'Siddharth Maurya', contactEmail: 'student@example.com' });
  assert.equal(updated.full_name, 'Siddharth Maurya');
  assert.equal(updated.contact_email, 'student@example.com');
  assert.equal(updated.role, 'Student');
  assert.equal(updated.profile_completed, 1);
  s.db.close();
});

test('Notes are only listed and fetched for their owner', () => {
  const s = openStore(':memory:');
  const user1 = s.upsert({ sub: 'one', email: 'one@example.com', name: 'One', email_verified: true });
  const user2 = s.upsert({ sub: 'two', email: 'two@example.com', name: 'Two', email_verified: true });
  const note = s.createNote({ userId: user1.id, title: 'Math notes', originalName: 'math.pdf', storedName: '1/math.pdf', mimeType: 'application/pdf', sizeBytes: 1200 });
  s.createNote({ userId: user2.id, title: 'Science notes', originalName: 'science.pdf', storedName: '2/science.pdf', mimeType: 'application/pdf', sizeBytes: 1400 });
  assert.equal(s.listNotesByUser(user1.id).length, 1);
  assert.equal(s.listNotesByUser(user2.id).length, 1);
  assert.equal(s.getNoteByIdForUser(note.id, user1.id).title, 'Math notes');
  assert.equal(s.getNoteByIdForUser(note.id, user2.id), null);
  s.db.close();
});

test('Deleting a user cascades sessions, notes, text notes, and todos', () => {
  const s = openStore(':memory:');
  const user = s.upsert({ sub: 'four', email: 'x@example.com', name: 'X', email_verified: true });
  s.createNote({ userId: user.id, title: 'History', originalName: 'history.txt', storedName: '1/history.txt', mimeType: 'text/plain', sizeBytes: 50 });
  s.createTextNote({ userId: user.id, title: 'Exam Tips', content: 'Study chapter 4' });
  s.createTodo({ userId: user.id, text: 'Submit assignment' });
  s.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update('session').digest('hex'), user.id, Date.now() + 60000);
  s.db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM text_notes').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM todos').get().n, 0);
  s.db.close();
});

test('Personal text notes are isolated by user and support update and delete', () => {
  const s = openStore(':memory:');
  const u1 = s.upsert({ sub: 'tn1', email: 'tn1@example.com', name: 'Student 1', email_verified: true });
  const u2 = s.upsert({ sub: 'tn2', email: 'tn2@example.com', name: 'Student 2', email_verified: true });

  const note1 = s.createTextNote({ userId: u1.id, title: 'Physics', content: 'Newton Laws' });
  s.createTextNote({ userId: u2.id, title: 'Chemistry', content: 'Organic reactions' });

  assert.equal(s.listTextNotesByUser(u1.id).length, 1);
  assert.equal(s.listTextNotesByUser(u2.id).length, 1);
  assert.equal(s.getTextNoteByIdForUser(note1.id, u1.id).title, 'Physics');
  assert.equal(s.getTextNoteByIdForUser(note1.id, u2.id), null);

  const updated = s.updateTextNoteForUser(note1.id, u1.id, { title: 'Physics Rev', content: 'Newton 3 Laws' });
  assert.equal(updated.title, 'Physics Rev');
  assert.equal(updated.content, 'Newton 3 Laws');

  assert.equal(s.deleteTextNoteByIdForUser(note1.id, u1.id), true);
  assert.equal(s.listTextNotesByUser(u1.id).length, 0);
  s.db.close();
});

test('Todos are isolated by user and support toggling completed and delete', () => {
  const s = openStore(':memory:');
  const u1 = s.upsert({ sub: 'td1', email: 'td1@example.com', name: 'Student 1', email_verified: true });
  const u2 = s.upsert({ sub: 'td2', email: 'td2@example.com', name: 'Student 2', email_verified: true });

  const todo1 = s.createTodo({ userId: u1.id, text: 'Read Chapter 1' });
  s.createTodo({ userId: u2.id, text: 'Solve Math practice' });

  assert.equal(s.listTodosByUser(u1.id).length, 1);
  assert.equal(s.listTodosByUser(u2.id).length, 1);
  assert.equal(todo1.completed, false);
  assert.equal(s.getTodoByIdForUser(todo1.id, u2.id), null);

  const toggled = s.toggleTodoForUser(todo1.id, u1.id, true);
  assert.equal(toggled.completed, true);

  assert.equal(s.deleteTodoForUser(todo1.id, u1.id), true);
  assert.equal(s.listTodosByUser(u1.id).length, 0);
  s.db.close();
});
