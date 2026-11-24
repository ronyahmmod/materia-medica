import { deleteApp, initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';
import { auth } from '../firebase';

export interface ProvisionedClientAccount {
  uid: string;
  email: string;
  reusedExisting: boolean;
}

export function generateStrongClientPassword(length = 14): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*-_';
  const all = upper + lower + digits + symbols;

  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);

  const chars: string[] = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digits[bytes[2] % digits.length],
    symbols[bytes[3] % symbols.length],
  ];

  for (let i = 4; i < length; i += 1) {
    chars.push(all[bytes[i] % all.length]);
  }

  // Fisher-Yates shuffle using crypto values
  const shuffleBytes = new Uint32Array(chars.length);
  crypto.getRandomValues(shuffleBytes);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = shuffleBytes[i] % (i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }

  return chars.join('');
}

/**
 * Provisions a Firebase Auth Email/Password user on an isolated secondary Firebase App
 * instance so the Super Admin's primary Google session stays untouched.
 */
export async function provisionClientEmailPasswordAccount(
  rawEmail: string,
  password: string
): Promise<ProvisionedClientAccount> {
  const email = rawEmail.trim().toLowerCase();
  const appName = `client-provisioner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const secondaryApp = initializeApp(firebaseConfig, appName);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    try {
      const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
      return {
        uid: cred.user.uid,
        email,
        reusedExisting: false,
      };
    } catch (err) {
      const code = (err as { code?: string })?.code || '';
      if (code === 'auth/email-already-in-use') {
        try {
          const existingCred = await signInWithEmailAndPassword(secondaryAuth, email, password);
          return {
            uid: existingCred.user.uid,
            email,
            reusedExisting: true,
          };
        } catch {
          throw new Error(
            `An authentication account for "${email}" already exists with a different password. Enter its current password to link it, use a new client email, or send a password reset email.`
          );
        }
      }
      if (code === 'auth/operation-not-allowed') {
        throw new Error(
          'EMAIL_PASSWORD_DISABLED: Enable "Email/Password" under Firebase Console -> Authentication -> Sign-in method before assigning client credentials.'
        );
      }
      if (code === 'auth/weak-password') {
        throw new Error('Assigned password is too weak. Use at least 8 characters with letters and numbers.');
      }
      if (code === 'auth/invalid-email') {
        throw new Error(`"${email}" is not a valid email address.`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  } finally {
    await signOut(secondaryAuth).catch(() => {});
    await deleteApp(secondaryApp).catch(() => {});
  }
}

export async function sendClientPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim().toLowerCase());
}
