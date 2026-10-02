# Nest Student Notes — Google Login + Private Uploads

Google sign-in wali responsive student-notes website. Student Google se login karta hai, dashboard par full name + contact email save karta hai, role fixed **Student** rehta hai, aur apne private note files upload kar sakta hai. Note list aur downloads sirf usi signed-in account ke liye visible hain.

## Features

- Google OAuth sign-in
- Student profile form: full name, contact email, role Student
- Private note uploads up to 10 MB per file
- Each signed-in student can list, download and delete only their own notes
- Supabase Postgres for accounts, profiles, sessions, notes, todos, and activity history
- Private Supabase Storage bucket for uploaded note files
- No external npm dependency

## Run

Node.js **24+** use karo.

```bash
cd google-login-fixed
npm run check
npm start
```

Browser mein `http://localhost:3000` kholo.

## .env setup

`.env` file mein apna Google OAuth client ID aur **enabled** client secret rakho:

```dotenv
PORT=3000
BASE_URL=http://localhost:3000
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-enabled-client-secret
DB_PATH=./data/users.sqlite
NODE_ENV=development
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SECRET_KEY=sb_secret_your-server-only-key
```

`SUPABASE_SECRET_KEY` is server-only. Isse `public/` files, Git, screenshots,
ya chat mein kabhi paste na karein. `supabase-schema.sql` Supabase SQL Editor
mein ek baar run karein; ye private storage bucket aur app tables banata hai.

## Google Console settings

OAuth client type: **Web application**

Authorized redirect URI exactly:

```text
http://localhost:3000/auth/google/callback
```

Agar app testing mode mein hai, Audience > Test users mein apna Google email add karo.

## Student workflow

1. Student **Continue with Google** se sign in karta hai.
2. Dashboard par full name aur contact email save karta hai.
3. Role field fixed **Student** hota hai.
4. Profile save hone ke baad note upload unlock hota hai.
5. Uploaded note sirf wahi signed-in account dekh, download ya delete kar sakta hai.

## Supabase mein kaunsa data store hota hai?

- Postgres tables mein Google account identifier/email/name, student profile,
  session/OAuth state metadata, uploaded-note metadata, personal text notes,
  todos, aur activity events.
- Uploaded note files private `student-notes` Storage bucket mein.
- Activity history records sign-in/out, dashboard/profile/note/todo views and
  changes. Note content aur personal note text activity details mein duplicate
  nahi hote.
- Purana local SQLite database aur uploads migration ke baad backup ke roop
  mein rehte hain.

Local data ko kisi naye empty Supabase project mein transfer karne ke liye:

```bash
npm run migrate:supabase
node migrate-to-supabase.mjs --apply
```

Pehla command sirf counts dikhata hai; doosra apply karke local data copy
karta hai. Non-empty Supabase tables hon to migration ruk jaati hai.

## Security model

- Google password app tak nahi aata.
- Access/refresh tokens database mein save nahi hote.
- Session cookie HttpOnly hai.
- Note APIs owner check karti hain, isliye ek user dusre user ka note list/download/delete nahi kar sakta.
- Profile save ke bina note upload allow nahi hota.
- Supabase tables par RLS enabled hai aur Storage bucket private hai. Website
  backend hi server-only Supabase key ke through access karta hai.

## Dashboard features and Supabase update

The dashboard includes note search, type/date filters and sorting; automatic
personal-note saving with a device-local draft recovery copy; private PDF/image
previews; task due dates and opt-in browser notifications; a saved light/dark
theme; print-friendly notes; JSON data export; and account/data deletion.
Browser reminders work while the dashboard is open. They are not background
push notifications.

If the existing Supabase project was created before task due dates were added,
run `supabase-migrations/20261002_todo_due_at.sql` once in the Supabase SQL
Editor. For a new Supabase setup, `supabase-schema.sql` already includes this
column. After applying it, redeploy the app so the dashboard feature is live.

## Useful commands

Config presence/format check:

```bash
npm run check
```

Tests:

```bash
npm test
```

project url "https://student-hub-w34g.onrender.com/"


Saved note metadata dekhne ke liye:

```bash
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('./data/users.sqlite'); console.table(db.prepare('SELECT id,user_id,title,original_name,size_bytes,created_at FROM notes').all()); db.close();"
```

Saved students dekhne ke liye:

```bash
node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync('./data/users.sqlite'); console.table(db.prepare('SELECT id,full_name,contact_email,role,created_at,last_login FROM users').all()); db.close();"
```

## Important notes

- `.env` ya client secret share mat karo.
- Agar secret accidentally expose ho jaye, Google Console mein usse disable karke naya secret banao.
- Uploaded files ka backup alag se rakhna hoga; sirf database backup enough nahi hai.
- Agar purane version se migrate kar rahe ho, existing `users.sqlite` work karega; new columns aur notes table automatically add ho jayenge.
