const LOCAL_USER_KEY = 'borangLocalUser';

export const getCurrentUser = async () => {
  try {
    const raw = window.localStorage.getItem(LOCAL_USER_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed?.email) {
      return null;
    }

    return {
      email: parsed.email,
      displayName: parsed.displayName || parsed.email,
      photoURL: parsed.photoURL || '',
    };
  } catch (error) {
    return null;
  }
};

export const getIdToken = async () => {
  return null;
};

export const signIn = async () => {
  const typed = window.prompt('Enter your email for local mode', 'qa@example.test');
  const email = String(typed || '').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return null;
  }

  const localUser = {
    email,
    displayName: email.split('@')[0],
    photoURL: '',
  };

  window.localStorage.setItem(LOCAL_USER_KEY, JSON.stringify(localUser));

  return {
    user: localUser,
  };
};

export const signOut = async () => {
  window.localStorage.removeItem(LOCAL_USER_KEY);
};
