"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from "react";
import {
  User,
  onAuthStateChanged,
  signOut as firebaseSignOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signInWithPhoneNumber,
  sendPasswordResetEmail,
  ConfirmationResult,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { auth, db, googleProvider, setupRecaptcha } from "@/lib/firebase";
import { UserProfile, UserRole, ROLE_ROUTES } from "@/lib/types";
import { useRouter } from "next/navigation";

// ---- localStorage helpers for profile fallback ----
const LS_PROFILES_KEY = "civicresq_profiles";

function getLocalProfiles(): Record<string, UserProfile> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_PROFILES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLocalProfile(uid: string, data: Partial<UserProfile>) {
  const profiles = getLocalProfiles();
  profiles[uid] = { ...(profiles[uid] || {}), ...data } as UserProfile;
  localStorage.setItem(LS_PROFILES_KEY, JSON.stringify(profiles));
}

function getLocalProfile(uid: string): UserProfile | null {
  const profiles = getLocalProfiles();
  return profiles[uid] || null;
}

// ---- End localStorage helpers ----

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signUp: (
    email: string,
    password: string,
    profileData: Omit<UserProfile, "uid" | "email" | "photoURL" | "approved" | "createdAt">
  ) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  sendPhoneOTP: (phone: string) => Promise<ConfirmationResult>;
  verifyPhoneOTP: (
    confirmationResult: ConfirmationResult,
    code: string,
    profileData?: Omit<UserProfile, "uid" | "email" | "photoURL" | "approved" | "createdAt">
  ) => Promise<void>;
  signOutUser: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  updateProfile: (data: Partial<UserProfile>) => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const bypassApproval = (process.env.NEXT_PUBLIC_BYPASS_RESPONDER_APPROVAL || "true") === "true";

  // Fetch user profile — tries Firestore first, falls back to localStorage
  async function fetchProfile(u: User): Promise<UserProfile | null> {
    try {
      const fireDb = db();
      const docRef = doc(fireDb, "users", u.uid);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const firestoreProfile = snap.data() as UserProfile;
        // Sync to localStorage as cache
        saveLocalProfile(u.uid, firestoreProfile);
        return firestoreProfile;
      }
    } catch (err) {
      console.warn("Firestore read failed, using localStorage fallback:", err);
    }
    // Fallback to localStorage
    return getLocalProfile(u.uid);
  }

  // Save profile — tries Firestore first, always saves to localStorage
  async function saveProfile(uid: string, data: Partial<UserProfile>) {
    // Always save to localStorage (ensures it works even if Firestore fails)
    saveLocalProfile(uid, data);
    try {
      const fireDb = db();
      const docRef = doc(fireDb, "users", uid);
      await setDoc(docRef, data, { merge: true });
    } catch (err) {
      console.warn("Firestore write failed, profile saved to localStorage:", err);
    }
  }

  // Redirect based on role
  function redirectToRoleDashboard(p: UserProfile) {
    if (p.role === "responder" && !p.approved && !bypassApproval) {
      router.push("/pending-approval");
      return;
    }
    router.push(ROLE_ROUTES[p.role]);
  }

  // Listen for auth state
  useEffect(() => {
    try {
      const fireAuth = auth();
      const unsubscribe = onAuthStateChanged(fireAuth, async (u) => {
        setUser(u);
        if (u) {
          const p = await fetchProfile(u);
          setProfile(p);
        } else {
          setProfile(null);
        }
        setLoading(false);
      });
      return () => unsubscribe();
    } catch {
      // Firebase not initialized (SSR)
      setLoading(false);
      return () => {};
    }
  }, []);

  // Email/Password sign up
  async function signUp(
    email: string,
    password: string,
    profileData: Omit<UserProfile, "uid" | "email" | "photoURL" | "approved" | "createdAt">
  ) {
    const fireAuth = auth();
    const cred = await createUserWithEmailAndPassword(fireAuth, email, password);
    const newProfile: UserProfile = {
      uid: cred.user.uid,
      email: cred.user.email,
      photoURL: cred.user.photoURL,
      approved: profileData.role !== "responder", // responders need approval
      createdAt: Date.now(),
      ...profileData,
    };
    await saveProfile(cred.user.uid, newProfile);
    setProfile(newProfile);
    redirectToRoleDashboard(newProfile);
  }

  // Email/Password sign in
  async function signIn(email: string, password: string) {
    const fireAuth = auth();
    const cred = await signInWithEmailAndPassword(fireAuth, email, password);
    const p = await fetchProfile(cred.user);
    if (p) {
      setProfile(p);
      redirectToRoleDashboard(p);
    } else {
      // No profile yet — send to create profile
      router.push("/complete-profile");
    }
  }

  // Google login
  async function signInWithGoogleFn() {
    const fireAuth = auth();
    const cred = await signInWithPopup(fireAuth, googleProvider);
    const existing = await fetchProfile(cred.user);
    if (existing) {
      setProfile(existing);
      redirectToRoleDashboard(existing);
    } else {
      // First time Google user — needs to complete profile
      router.push("/complete-profile");
    }
  }

  // Phone OTP — Step 1: Send code
  async function sendPhoneOTP(phone: string): Promise<ConfirmationResult> {
    const fireAuth = auth();
    const verifier = setupRecaptcha("recaptcha-container");
    return signInWithPhoneNumber(fireAuth, phone, verifier);
  }

  // Phone OTP — Step 2: Verify code
  async function verifyPhoneOTP(
    confirmationResult: ConfirmationResult,
    code: string,
    profileData?: Omit<UserProfile, "uid" | "email" | "photoURL" | "approved" | "createdAt">
  ) {
    const cred = await confirmationResult.confirm(code);
    const existing = await fetchProfile(cred.user);
    if (existing) {
      setProfile(existing);
      redirectToRoleDashboard(existing);
    } else if (profileData) {
      const newProfile: UserProfile = {
        uid: cred.user.uid,
        email: cred.user.email,
        photoURL: cred.user.photoURL,
        approved: profileData.role !== "responder",
        createdAt: Date.now(),
        ...profileData,
      };
      await saveProfile(cred.user.uid, newProfile);
      setProfile(newProfile);
      redirectToRoleDashboard(newProfile);
    } else {
      router.push("/complete-profile");
    }
  }

  // Sign out
  async function signOutUser() {
    const fireAuth = auth();
    await firebaseSignOut(fireAuth);
    setUser(null);
    setProfile(null);
    router.push("/login");
  }

  // Password reset
  async function resetPasswordFn(email: string) {
    const fireAuth = auth();
    await sendPasswordResetEmail(fireAuth, email);
  }

  // Update profile
  async function updateProfileData(data: Partial<UserProfile>) {
    if (!user) return;
    await saveProfile(user.uid, data);
    setProfile((prev) => (prev ? { ...prev, ...data } : prev));
  }

  const value: AuthContextType = {
    user,
    profile,
    loading,
    signUp,
    signIn,
    signInWithGoogle: signInWithGoogleFn,
    sendPhoneOTP,
    verifyPhoneOTP,
    signOutUser,
    resetPassword: resetPasswordFn,
    updateProfile: updateProfileData,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

