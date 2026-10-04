/*
 * Login / signup page logic.
 *
 * One document serves both routes: server.js maps /login and /signup to
 * auth.html and the mode comes from location.pathname, so the two never drift.
 */
import { client, safeNext } from './auth.js';

const path = location.pathname.replace(/\/+$/, '');
const isSignup = path === '/signup';
const next = safeNext('/app');

const $ = (id) => document.getElementById(id);
const title = $('auth-title');
const sub = $('auth-sub');
const switchEl = $('auth-switch');
const msg = $('auth-msg');
const googleBtn = $('google-btn');
const googleLabel = $('google-label');
const emailBtn = $('email-btn');
const form = $('email-form');
const emailInput = $('email');

function say(text, kind) {
  msg.textContent = text;
  msg.dataset.kind = kind;           // 'error' | 'ok'
}

function fail(err) {
  const code = err && (err.code || '');
  const text = String((err && err.message) || err || 'Something went wrong.');
  if (/provider_not_enabled|unabled|not enabled/i.test(code + text)) {
    return say('Google sign-in is not switched on yet. Use the email link for now, or ask the site owner to enable Google in the Supabase dashboard.', 'error');
  }
  if (/email_not_confirmed/i.test(code)) {
    return say('That address has not been confirmed yet — open the link we just emailed you.', 'error');
  }
  if (/rate limit|too many/i.test(code + text)) {
    return say('Too many attempts. Wait a minute and try again.', 'error');
  }
  say(text, 'error');
}

/* ---------- copy ---------- */
if (isSignup) {
  document.title = 'Cortex — create your account';
  title.textContent = 'Create your Cortex account';
  sub.textContent = 'Free forever for up to 50 questions a day. No card, no password.';
  googleLabel.textContent = 'Sign up with Google';
  emailBtn.textContent = 'Email me a sign-up link';
  switchEl.innerHTML = 'Already have an account? <a href="/login">Sign in</a>';
} else {
  title.textContent = 'Sign in to Cortex';
  sub.textContent = 'Pick up where you left off — your workspaces, notes and explanations are waiting.';
  googleLabel.textContent = 'Continue with Google';
  emailBtn.textContent = 'Send me a sign-in link';
  switchEl.innerHTML = 'New here? <a href="/signup">Create an account</a>';
}

/* ---------- already signed in? go straight through ---------- */
async function currentSession() {
  try {
    const { data } = await client.auth.getSession();
    return data.session;
  } catch {
    return null;
  }
}

if (await currentSession()) location.replace(next);

/* Supabase appends tokens to the URL after an OAuth or magic-link redirect;
   the client parses them, fires SIGNED_IN, and we continue. */
client.auth.onAuthStateChange((_event, session) => {
  if (session) location.replace(next);
});

/* ---------- Google ---------- */
googleBtn.addEventListener('click', () => {
  if (!client) return say('The sign-in library failed to load — reload the page.', 'error');
  googleBtn.disabled = true;
  googleLabel.textContent = 'Opening Google…';
  client.auth
    .signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + next },
    })
    .then(({ error }) => {
      if (error) {
        googleBtn.disabled = false;
        googleLabel.textContent = isSignup ? 'Sign up with Google' : 'Continue with Google';
        fail(error);
      }
      // No error means the browser is being handed to Google; stay disabled.
    });
});

/* ---------- email magic link ---------- */
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!client) return say('The sign-in library failed to load — reload the page.', 'error');

  const email = emailInput.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return say('That does not look like an email address.', 'error');
  }

  emailBtn.disabled = true;
  const original = emailBtn.textContent;
  emailBtn.textContent = 'Sending…';

  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      // Same destination as the OAuth return, so both paths land on `next`.
      emailRedirectTo: location.origin + next,
    },
  });

  if (error) {
    emailBtn.disabled = false;
    emailBtn.textContent = original;
    return fail(error);
  }

  emailBtn.textContent = 'Link sent ✓';
  say(
    `Check ${email} — we sent you a link. It signs you in with no password. ` +
    'If it does not arrive in a minute, look in spam.',
    'ok',
  );
  // Keep the button disabled for a while: a second send is how the rate limit
  // gets hit, and there is nothing to do until the link is used.
  setTimeout(() => {
    emailBtn.disabled = false;
    emailBtn.textContent = original;
  }, 45000);
});

emailInput.focus();
