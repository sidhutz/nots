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

test('Deleting a user cascades sessions and notes', () => {
  const s = openStore(':memory:');
  const user = s.upsert({ sub: 'four', email: 'x@example.com', name: 'X', email_verified: true });
  s.createNote({ userId: user.id, title: 'History', originalName: 'history.txt', storedName: '1/history.txt', mimeType: 'text/plain', sizeBytes: 50 });
  s.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update('session').digest('hex'), user.id, Date.now() + 60000);
  s.db.prepare('DELETE FROM users WHERE id=?').run(user.id);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
  s.db.close();
});
