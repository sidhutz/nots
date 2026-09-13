# Nest Student Notes — Google Login + Private Uploads

Google sign-in wali responsive student-notes website. Student Google se login karta hai, dashboard par full name + contact email save karta hai, role fixed **Student** rehta hai, aur apne private note files upload kar sakta hai. Note list aur downloads sirf usi signed-in account ke liye visible hain.

## Features

- Google OAuth sign-in
- Student profile form: full name, contact email, role Student
- Private note uploads up to 10 MB per file
- Each signed-in student can list, download and delete only their own notes
- Local SQLite database for metadata
- Local private uploads folder for note files
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
```

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

## Data kahan store hota hai?

Default setup mein:

```text
google-login-fixed/
├── data/
│   └── users.sqlite
└── uploads/
    └── <user-id>/
```

### SQLite database mein

- Google account identifier
- Google email, Google name, picture URL
- Student full name
- Student contact email
- Fixed role Student
- Session metadata
- Note metadata: title, original file name, mime type, size, upload time

### Upload folder mein

- Actual note files

## Security model

- Google password app tak nahi aata.
- Access/refresh tokens database mein save nahi hote.
- Session cookie HttpOnly hai.
- Note APIs owner check karti hain, isliye ek user dusre user ka note list/download/delete nahi kar sakta.
- Profile save ke bina note upload allow nahi hota.

## Useful commands

Config presence/format check:

```bash
npm run check
```

Tests:

```bash
npm test
```

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
