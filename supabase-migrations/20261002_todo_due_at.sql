-- Add task due dates for reminders. Safe to run more than once.
alter table public.todos add column if not exists due_at timestamptz;
