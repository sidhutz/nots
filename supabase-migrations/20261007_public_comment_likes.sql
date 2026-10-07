-- Likes on individual public comments. Safe to rerun.

alter table public.public_post_comments
  add column if not exists like_count bigint not null default 0;

create table if not exists public.public_comment_likes (
  comment_id bigint not null references public.public_post_comments(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create index if not exists public_comment_likes_user_idx
  on public.public_comment_likes(user_id, comment_id);

update public.public_post_comments c
set like_count = (select count(*) from public.public_comment_likes l where l.comment_id = c.id);

alter table public.public_comment_likes enable row level security;
grant all on table public.public_comment_likes to service_role;

create or replace function public.sync_comment_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_comment_id bigint;
  amount integer;
begin
  if tg_op = 'DELETE' then
    target_comment_id := old.comment_id;
    amount := -1;
  else
    target_comment_id := new.comment_id;
    amount := 1;
  end if;

  update public.public_post_comments
  set like_count = greatest(like_count + amount, 0)
  where id = target_comment_id;

  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists public_comment_likes_counter on public.public_comment_likes;
create trigger public_comment_likes_counter
after insert or delete on public.public_comment_likes
for each row execute function public.sync_comment_like_count();
