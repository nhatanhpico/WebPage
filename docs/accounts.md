# Managing accounts (CLI)

Shared Notes has **one shared space** and **any number of accounts**. Everyone who signs in, with any account, sees the same notes in real time. Each person's notes show on the right on their own devices and on the left for everyone else, labelled with their **account name**. The name can't be changed from the website, only with the commands below.

All commands run on your computer, in a terminal (Terminal or iTerm, not a pipe), from the project folder:

```bash
cd /Users/nhatanh245/Project/WebPage
npm install          # only the first time
```

Every command asks before it writes anything, and at the end offers **"Publish now (commit + push)? [Y/n]"**. Press Enter to publish: it commits only `src/account.js` with the message `Update accounts` (account names never appear in git history) and pushes. GitHub Pages redeploys about a minute later. Press Ctrl+C at any point to cancel without changes.

## Quick reference

| Command | What it does |
|---|---|
| `npm run account` | Menu with all the options below |
| `npm run account:add` | Add an account. The very first one also creates the shared space. |
| `npm run account:change` | Rename your account and/or change its password |
| `npm run account:delete` | Delete an account |
| `npm run account:list` | Show all account names |
| `npm run account:status` | How many accounts, when they last changed, whether that change is published |
| `npm run account:reset` | Delete **every** account (only if all passwords are lost) |

Add `-- --no-push` to any command to write the file without committing, e.g. `npm run account:add -- --no-push`.

## Create the first account

```
$ npm run account:add
Creating the first account (this also creates the shared space).

New account:
  Account name (also shown on notes): Anh
  Password:            ← typing is hidden
  Repeat password:
✔ Account "Anh" added (1 account in total).
Publish now (commit + push)? [Y/n]
```

## Add another account

Adding needs an **existing** account to unlock the space, so only members can add members:

```
$ npm run account:add
Adding an account needs an existing account to unlock the space.

  Account: Anh
  Password:
  Checking… ✔ signed in as Anh

New account:
  Account name (also shown on notes): Wei
  Password:
  Repeat password:
✔ Account "Wei" added (2 accounts in total).
Publish now (commit + push)? [Y/n]
```

Give the new person their account name and password in person or through a private channel.

## Rename or change a password

Sign in with the account you want to change. Press Enter to keep the current name or password:

```
$ npm run account:change
Sign in with the account you want to change.

  Account: Wei
  Password:
  Checking… ✔ signed in as Wei

  New account name (Enter to keep "Wei"): Wei Chen
  New password (Enter to keep the current one):
✔ Account updated: "Wei" → "Wei Chen".
```

Devices signed in with that account are signed out after publishing and must sign in again with the new details.

## Delete an account

Sign in with any account, then pick one from the list:

```
$ npm run account:delete
Sign in with any account to manage accounts.
  …
Accounts:
  1) Anh  (you)
  2) Wei Chen

Delete which account? (number, Enter to cancel) 2
Type "yes" to delete "Wei Chen": yes
✔ Account "Wei Chen" deleted. Its devices are signed out the next time they open the site.
```

Deleting the **last** account locks the site for everyone until you add a new one.

## Forgot a password

- **Another account still works:** sign in with it, delete the forgotten account, then add it again with a new password.
- **Every password is lost:** run `npm run account:reset`, type `yes`, then `npm run account:add` to start over.

## Rules and good to know

- **Account names** can be up to 32 characters and must be unique. Sign-in ignores upper/lower case (`anh` = `Anh`), but notes show the name exactly as you created it.
- **Passwords** need at least 10 characters. Use long ones: `src/account.js` is public on the website, so a weak password could be guessed offline.
- **What `src/account.js` contains:** a salt and, per account, a check value plus encrypted copies of the space key and the account name. It never holds a password, and names are readable only by signed-in members.
- **Deleting an account** stops that account from signing in and signs out its devices the next time they open the site. Someone who copied the space key out of their browser beforehand could in principle still connect. If you need to lock out someone you don't trust, run `npm run account:reset` and re-create the accounts you want to keep.
- **Don't edit `src/account.js` by hand.** Always use these commands.
