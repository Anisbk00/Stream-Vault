'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  Camera,
  Check,
  Crown,
  FolderOpen,
  Info,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  Subtitles,
  Users,
  X,
} from 'lucide-react';
import RetroShield from './RetroShield';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { useAuthStore, getAuthToken, useSettingsStore } from '@/store';
import { useWatchPartyStore } from '@/store/watch-party';
import { useWatchParty } from '@/hooks/use-watch-party';
import type { WatchPartyData } from '@/lib/watch-party-types';
import { supabase, uploadAvatar, updateMyProfile } from '@/lib/supabase';
import { compressImage } from '@/lib/image-utils';
import { format } from 'date-fns';

// ── Constants ────────────────────────────────────────────────
const AVATAR_MAX_FILE_SIZE = 5 * 1024 * 1024;
const NAME_MAX_LENGTH = 30;

const SUBTITLE_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'it', label: 'Italiano' },
  { code: 'pt', label: 'Português' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh', label: '中文' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'ru', label: 'Русский' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'pl', label: 'Polski' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'sv', label: 'Svenska' },
  { code: 'th', label: 'ไทย' },
  { code: 'uk', label: 'Українська' },
];

// ── Types ─────────────────────────────────────────────────

interface AppUser {
  id: string;
  name: string;
  avatar_url: string | null;
  role: string;
  is_active: boolean;
  member_since: string;
  party: { partyId: string; partyTitle: string | null; memberStatus: 'joined' | 'invited' } | null;
}

// ── Settings Row ──────────────────────────────────────────────

interface SettingsRowProps {
  icon: React.ReactNode;
  label: string;
  value?: string;
  subtitle?: string;
  iconColor?: string;
  onClick?: () => void;
  children?: React.ReactNode;
  endAdornment?: React.ReactNode;
}

function SettingsRow({ icon, label, value, subtitle, iconColor, onClick, children, endAdornment }: SettingsRowProps) {
  const Wrapper = onClick ? 'button' : 'div';
  const wrapperProps = onClick
    ? { onClick, className: 'w-full text-left cursor-pointer press-effect' }
    : { className: 'w-full text-left' };

  return (
    <Wrapper {...wrapperProps}>
      <div className="flex items-center gap-3.5 py-3">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: iconColor ? `${iconColor}15` : 'rgba(255,255,255,0.06)' }}
        >
          <div style={{ color: iconColor || '#A0A0A0' }} className="flex items-center justify-center">{icon}</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-medium text-[#F5F5F5]">{label}</span>
            {endAdornment}
          </div>
          {value && <p className="text-[13px] text-[#808080] mt-0.5 truncate">{value}</p>}
          {subtitle && <p className="text-[12px] text-[#606060] mt-0.5">{subtitle}</p>}
        </div>
        {children}
      </div>
    </Wrapper>
  );
}

// ── Section Header ────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <h3 className="text-[13px] font-semibold text-[#808080] uppercase tracking-wider px-1 mb-1 mt-2">{title}</h3>
  );
}

// ── Inline icons ──────────────────────────────────────────────

function HeartIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
  );
}

function ClockIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

// ── Password Change Dialog ────────────────────────────────────

function PasswordChangeDialog({ onClose }: { onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(async () => {
    setError('');
    if (newPassword.length < 6) { setError('New password must be at least 6 characters'); return; }
    if (newPassword !== confirmPassword) { setError('Passwords do not match'); return; }

    setIsLoading(true);
    try {
      // Re-authenticate with current password before changing
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: useAuthStore.getState().user?.email ?? '',
        password: currentPassword,
      });
      if (signInError) { setError('Current password is incorrect'); return; }

      // Change password
      const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
      if (updateError) { setError(updateError.message); return; }

      toast.success('Password changed');
      onClose();
    } catch {
      setError('Failed to change password');
    } finally {
      setIsLoading(false);
    }
  }, [currentPassword, newPassword, confirmPassword, onClose]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
    >
      <div className="rounded-2xl bg-[#141414] border border-white/[0.08] p-5 w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-[#F5F5F5] flex items-center gap-2">
            <KeyRound className="size-4 text-sv-red" />
            Change Password
          </h3>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/15 transition-colors cursor-pointer">
            <X className="size-4 text-[#A0A0A0]" />
          </button>
        </div>
        <div className="space-y-3">
          <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Current password" className="w-full bg-white/[0.06] border border-white/[0.12] rounded-xl px-4 py-3 text-sm text-[#F5F5F5] placeholder:text-[#505050] outline-none focus:border-sv-red/50 transition-colors" />
          <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (min 6 chars)" className="w-full bg-white/[0.06] border border-white/[0.12] rounded-xl px-4 py-3 text-sm text-[#F5F5F5] placeholder:text-[#505050] outline-none focus:border-sv-red/50 transition-colors" />
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm new password" className="w-full bg-white/[0.06] border border-white/[0.12] rounded-xl px-4 py-3 text-sm text-[#F5F5F5] placeholder:text-[#505050] outline-none focus:border-sv-red/50 transition-colors" />
          {error && <p className="text-xs text-sv-red">{error}</p>}
          <button onClick={handleSubmit} disabled={isLoading} className="w-full flex items-center justify-center gap-2 bg-sv-red hover:bg-sv-red-hover disabled:opacity-30 text-white font-semibold py-3 rounded-xl transition-colors cursor-pointer press-effect">
            {isLoading ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
            {isLoading ? 'Changing...' : 'Change Password'}
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ── Profile Page ──────────────────────────────────────────────

export default function ProfilePage() {
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);
  const status = useAuthStore((s) => s.status);
  const setProfile = useAuthStore((s) => s.setProfile);
  const logout = useAuthStore((s) => s.logout);

  const preferredSubtitles = useSettingsStore((s) => s.preferredSubtitles);
  const togglePreferredSubtitle = useSettingsStore((s) => s.togglePreferredSubtitle);
  const downloadFolderName = useSettingsStore((s) => s.downloadFolderName);
  const setDownloadFolderName = useSettingsStore((s) => s.setDownloadFolderName);


  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [isAvatarLoading, setIsAvatarLoading] = useState(false);
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [allUsers, setAllUsers] = useState<AppUser[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [expandedUserId, setExpandedUserId] = useState<string | null>(null);
  const [isEditingSubtitles, setIsEditingSubtitles] = useState(false);
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const wpSocket = useWatchParty();
  // Stable ref to wpSocket — prevents stale closures in async callbacks
  // (useWatchParty() returns a new object every render because its useCallback
  //  functions depend on user/profile, causing handleInviteToWatchParty to be
  //  recreated on every render and capture outdated wpSocket references)
  const wpSocketRef = useRef(wpSocket);
  useEffect(() => {
    wpSocketRef.current = wpSocket;
  }, [wpSocket]);
  const isInParty = useWatchPartyStore((s) => s.isInParty);
  const isHost = useWatchPartyStore((s) => s.isHost);
  const currentParty = useWatchPartyStore((s) => s.currentParty);
  const setRoomVisible = useWatchPartyStore((s) => s.setRoomVisible);



  const name = profile?.display_name ?? '';
  const email = profile?.email ?? user?.email ?? '';
  const avatarUrl = profile?.avatar_url ?? null;

  // ── Users refresh key (defined early — referenced by handleAvatarChange, handleSaveName, etc.) ──
  const [usersRefreshKey, setUsersRefreshKey] = useState(0);
  const refreshUsers = useCallback(() => setUsersRefreshKey((k) => k + 1), []);

  // Sync drafts with store
  useEffect(() => { setNameDraft(name); }, [name]);
  // Load avatar: try IndexedDB cache first (works offline), fall back to Supabase URL
  useEffect(() => {
    if (!avatarUrl) { setAvatarPreview(null); return; }
    const userId = user?.id;
    if (!userId) { setAvatarPreview(avatarUrl); return; }
    (async () => {
      try {
        const { loadAvatar } = await import('@/lib/download-storage');
        const blob = await loadAvatar(userId);
        if (blob) {
          setAvatarPreview(URL.createObjectURL(blob));
          return;
        }
      } catch { /* IndexedDB unavailable */ }
      setAvatarPreview(avatarUrl);
    })();
  }, [avatarUrl, user?.id]);

  // ── Avatar ─────────────────────────────────────────────

  const handleAvatarClick = useCallback(() => { fileInputRef.current?.click(); }, []);

  const handleAvatarChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please select an image file'); e.target.value = ''; return; }
    if (file.size > AVATAR_MAX_FILE_SIZE) { toast.error('Image must be under 5 MB'); e.target.value = ''; return; }

    setIsAvatarLoading(true);
    try {
      const compressed = await compressImage(file);
      const blob = await (await fetch(compressed)).blob();
      const jpegFile = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
      if (!user) { toast.error('Not signed in'); return; }
      const url = await uploadAvatar(user.id, jpegFile);

      if (url) {
        // Update profile in DB via authed client
        const updated = await updateMyProfile(user.id, { avatar_url: url });
        if (updated) {
          setProfile(updated);
          setAvatarPreview(url);

          // Save the new avatar blob to IndexedDB directly — avoids race
          // condition where NavProfileAvatar loads the stale cached blob
          // before setProfile's async saveAvatar completes.
          try {
            const { saveAvatar } = await import('@/lib/download-storage');
            await saveAvatar(user.id, blob);
          } catch { /* IndexedDB save failed — NavProfileAvatar will use network URL */ }

          // Refresh All Users list so the new avatar appears instantly
          refreshUsers();

          // Broadcast profile update to watch party members
          wpSocketRef.current.broadcastProfileUpdate?.(
            updated.display_name,
            updated.avatar_url,
          );

          toast.success('Photo updated');
        } else {
          toast.error('Photo uploaded but profile update failed. Please try again.');
        }
      } else {
        toast.error('Upload failed. Try again.');
      }
    } catch {
      toast.error('Failed to process image');
    } finally {
      setIsAvatarLoading(false);
    }
    e.target.value = '';
  }, [user, setProfile, refreshUsers]);

  // ── Name ───────────────────────────────────────────────

  const handleStartEditName = useCallback(() => {
    setNameDraft(name);
    setIsEditingName(true);
    requestAnimationFrame(() => nameInputRef.current?.focus());
  }, [name]);

  const handleSaveName = useCallback(async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed.length < 2) { toast.error('Name must be at least 2 characters'); setNameDraft(name); setIsEditingName(false); return; }
    if (!user?.id) { toast.error('Not signed in'); return; }
    try {
      const updated = await updateMyProfile(user.id, { display_name: trimmed });
      if (!updated) { toast.error('Failed to update name'); setNameDraft(name); setIsEditingName(false); return; }
      setProfile(updated);
      setIsEditingName(false);

      // Refresh All Users list so the new name appears instantly
      refreshUsers();

      // Broadcast profile update to watch party members
      wpSocketRef.current.broadcastProfileUpdate?.(
        updated.display_name,
        updated.avatar_url,
      );

      toast.success('Name updated');
    } catch {
      toast.error('Connection error');
      setNameDraft(name);
      setIsEditingName(false);
    }
  }, [nameDraft, name, user, setProfile, refreshUsers]);

  const handleCancelEditName = useCallback(() => { setNameDraft(name); setIsEditingName(false); }, [name]);

  const handleNameKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSaveName();
    if (e.key === 'Escape') handleCancelEditName();
  }, [handleSaveName, handleCancelEditName]);

  // ── Logout ─────────────────────────────────────────────

  const handleLogout = useCallback(async () => {
    setIsLoggingOut(true);
    try {
      await logout();
      toast.success('Signed out');
    } catch {
      toast.error('Failed to sign out');
    } finally {
      setIsLoggingOut(false);
    }
  }, [logout]);

  // ── Download Folder ────────────────────────────────

  const handleChooseDownloadFolder = useCallback(async () => {
    if (!('showDirectoryPicker' in window)) {
      toast.error('Folder picker is only available in Chrome and Edge on desktop');
      return;
    }
    setIsPickingFolder(true);
    try {
      const dirHandle = await (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'readwrite' });
      // Verify permission
      const perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        const reqPerm = await dirHandle.requestPermission({ mode: 'readwrite' });
        if (reqPerm !== 'granted') {
          toast.error('Permission denied — please grant read/write access');
          setIsPickingFolder(false);
          return;
        }
      }
      // Store the handle in IndexedDB for persistence (handles can't be serialized to localStorage)
      const { saveDirectoryHandle } = await import('@/lib/download-storage');
      await saveDirectoryHandle(dirHandle);
      setDownloadFolderName(dirHandle.name);
      toast.success(`Downloads will auto-save to "${dirHandle.name}"`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled — no action needed
      } else {
        toast.error('Could not select folder');
      }
    } finally {
      setIsPickingFolder(false);
    }
  }, [setDownloadFolderName]);

  // ── Fetch all users ─────────────────────────────────
  // Refresh users list when the current user joins or leaves a watch party.
  // This ensures the "All Users" list updates the current user's party status
  // (e.g., "Pending invite" → "In a watch party" after accepting an invite).
  // We track the previous isInParty value to only refresh on actual transitions.
  const prevIsInPartyRef = useRef(isInParty);
  useEffect(() => {
    if (prevIsInPartyRef.current !== isInParty) {
      prevIsInPartyRef.current = isInParty;
      refreshUsers();
    }
  }, [isInParty, refreshUsers]);

  // Refresh users list when a party member's status changes (e.g., invited → joined).
  // Without this, the "All Users" section stays stale when a remote member accepts
  // an invite — the host never sees the update from "Pending invite" to "In a watch party".
  const prevMembersKeyRef = useRef('');
  const membersKey = currentParty?.members.map((m) => `${m.userId}:${m.memberStatus}`).join('|') ?? '';
  useEffect(() => {
    if (prevMembersKeyRef.current && prevMembersKeyRef.current !== membersKey) {
      refreshUsers();
    }
    prevMembersKeyRef.current = membersKey;
  }, [membersKey, refreshUsers]);

  useEffect(() => {
    if (status !== 'authenticated') return;

    let mounted = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    async function fetchUsers() {
      setIsLoadingUsers(true);
      try {
        const token = await getAuthToken();
        if (!token) return;
        const res = await fetch('/api/users', {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok) {
          if (mounted) toast.error('Failed to load users list');
          return;
        }
        const json = await res.json();
        if (mounted) setAllUsers(json.users ?? []);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (mounted) toast.error('Network error loading users');
      } finally {
        clearTimeout(timeout);
        if (mounted) setIsLoadingUsers(false);
      }
    }

    fetchUsers();
    return () => {
      mounted = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [status, usersRefreshKey]);

  // ── Watch Party Invite ────────────────────────────────

  const [isInviting, setIsInviting] = useState<string | null>(null);
  const [isEndingParty, setIsEndingParty] = useState(false);
  const isInvitingRef = useRef(false);

  const handleEndParty = useCallback(async () => {
    if (isEndingParty) return;
    setIsEndingParty(true);
    try {
      const socket = wpSocketRef.current;
      if (!socket?.endRoom) {
        toast.error('Watch party not connected. Please refresh the page.');
        return;
      }
      await socket.endRoom();
      refreshUsers();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to end party';
      toast.error(message);
    } finally {
      setIsEndingParty(false);
    }
  }, [isEndingParty, refreshUsers]);

  const handleInviteToWatchParty = useCallback(async (targetUserId: string) => {
    if (isInvitingRef.current) return
    isInvitingRef.current = true
    setIsInviting(targetUserId)

    try {
      const socket = wpSocketRef.current
      if (!socket?.createRoom || !socket?.inviteUser) {
        toast.error('Watch party not connected. Please refresh the page.', { id: 'wp-invite-flow' })
        return
      }

      const currentlyInParty = useWatchPartyStore.getState().isInParty

      if (!currentlyInParty) {
        toast.loading('Creating watch party...', { id: 'wp-invite-flow', duration: 15_000 })

        const party = await socket.createRoom()
        if (!party) {
          const storeParty = useWatchPartyStore.getState().currentParty
          if (!storeParty) {
            toast.error('Could not create a watch party. Please try again.', { id: 'wp-invite-flow' })
            return
          }
        }

        toast.loading('Party created! Sending invitation...', { id: 'wp-invite-flow', duration: 15_000 })
      } else {
        toast.loading('Sending invitation...', { id: 'wp-invite-flow', duration: 15_000 })
      }

      const partyState = useWatchPartyStore.getState().currentParty
      const partyId = partyState?.id
      if (!partyId) {
        toast.error('Watch party not found. Please try again.', { id: 'wp-invite-flow' })
        return
      }

      const inviteSuccess = await socket.inviteUser(partyId, targetUserId)

      if (inviteSuccess) {
        toast.success('Invitation sent!', { id: 'wp-invite-flow' })
        refreshUsers()
      } else {
        // inviteUser showed its own error toast
        toast.dismiss('wp-invite-flow')
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send invitation. Please try again.'
      toast.error(message, { id: 'wp-invite-flow' })
    } finally {
      isInvitingRef.current = false
      setIsInviting(null)
    }
  }, [refreshUsers])

  // ── Derived ────────────────────────────────────────────

  const initials = name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const memberSinceFormatted = (() => {
    try { return format(new Date(profile?.created_at ?? Date.now()), 'MMMM yyyy'); }
    catch { return 'Recently'; }
  })();

  return (
    <div className="px-4 max-w-2xl mx-auto pb-8">
      <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarChange} className="hidden" />

      {showPasswordDialog ? (
        <PasswordChangeDialog onClose={() => setShowPasswordDialog(false)} />
      ) : (
        <>
          {/* ── Profile Header ──────────────────────────────── */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: 'easeOut' }} className="flex flex-col items-center pt-14 pb-6">
            <div className="relative group" onClick={handleAvatarClick}>
              <div className="w-[100px] h-[100px] rounded-full overflow-hidden border-2 border-white/10 cursor-pointer transition-all duration-300 group-hover:border-sv-red/50 group-hover:shadow-lg group-hover:shadow-sv-red/10">
                <Avatar className="w-full h-full">
                  <AvatarImage src={avatarPreview || undefined} alt={name} className="object-cover" />
                  <AvatarFallback className="text-2xl font-bold bg-[#1a1a1a] text-sv-red">{initials || '?'}</AvatarFallback>
                </Avatar>
              </div>
              {isAvatarLoading && (
                <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center"><Loader2 className="size-6 text-white animate-spin" /></div>
              )}
              {!isAvatarLoading && (
                <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200 cursor-pointer"><Camera className="size-6 text-white" /></div>
              )}
            </div>
            <p className="text-[11px] text-[#606060] mt-2">Tap to change photo</p>

            {/* Name */}
            <div className="mt-3 flex items-center gap-2">
              {isEditingName ? (
                <div className="flex items-center gap-1.5">
                  <input ref={nameInputRef} type="text" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={handleNameKeyDown} maxLength={NAME_MAX_LENGTH} className="bg-transparent text-xl font-bold text-[#F5F5F5] text-center outline-none border-b-2 border-sv-red px-2 py-0.5" style={{ minWidth: '120px' }} />
                  <button onClick={handleSaveName} className="w-7 h-7 flex items-center justify-center rounded-full bg-sv-red/20 hover:bg-sv-red/30 transition-colors cursor-pointer" aria-label="Save"><Check className="size-4 text-sv-red" /></button>
                  <button onClick={handleCancelEditName} className="w-7 h-7 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/15 transition-colors cursor-pointer" aria-label="Cancel"><X className="size-4 text-[#A0A0A0]" /></button>
                </div>
              ) : (
                <button onClick={handleStartEditName} className="flex items-center gap-1.5 cursor-pointer group/name press-effect">
                  <h1 className="text-xl font-bold text-[#F5F5F5] group-hover/name:text-sv-red transition-colors">{name}</h1>
                  <span className="text-[#606060] group-hover/name:text-[#A0A0A0] transition-colors">
                    <svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></svg>
                  </span>
                </button>
              )}
            </div>

            {/* Email (read-only) */}
            <p className="text-sm text-[#A0A0A0] mt-1">{email}</p>
            <p className="text-xs text-[#606060] mt-1">Member since {memberSinceFormatted}</p>
          </motion.div>

          {/* ── Account ──────────────────────────────────── */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.1, ease: 'easeOut' }}>
            <SectionHeader title="Account" />
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] px-4">
              <SettingsRow icon={<Info className="size-[18px]" />} label="Email" value={email} subtitle="Set by admin" iconColor="#808080" />
              <div className="h-px bg-white/[0.06] ml-[52px]" />
              <SettingsRow icon={<KeyRound className="size-[18px]" />} label="Change Password" subtitle="Update your account password" iconColor="#F5C842" onClick={() => setShowPasswordDialog(true)} />
            </div>
          </motion.div>

          {/* ── Offline Subtitles ────────────────────────────── */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.15, ease: 'easeOut' }} className="mt-6">
            <SectionHeader title="Offline Subtitles" />
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] px-4 py-3">
              <SettingsRow
                icon={<Subtitles className="size-[18px]" />}
                label="Preferred Subtitles"
                value={preferredSubtitles.length > 0
                  ? preferredSubtitles.map((c) => SUBTITLE_LANGUAGES.find((l) => l.code === c)?.label || c).join(', ')
                  : 'All available'}
                subtitle="Auto-downloaded with videos for offline playback"
                iconColor="#4CAF50"
                onClick={() => setIsEditingSubtitles(!isEditingSubtitles)}
              />
              <AnimatePresence>
                {isEditingSubtitles && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-wrap gap-2 pt-2 pb-1">
                      {SUBTITLE_LANGUAGES.map((lang) => {
                        const isSelected = preferredSubtitles.includes(lang.code);
                        return (
                          <button
                            key={lang.code}
                            type="button"
                            onClick={() => togglePreferredSubtitle(lang.code)}
                            className={`px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all cursor-pointer press-effect ${
                              isSelected
                                ? 'bg-sv-red/20 text-sv-red border border-sv-red/30'
                                : 'bg-white/[0.04] text-[#808080] border border-white/[0.08] hover:bg-white/[0.08]'
                            }`}
                          >
                            {lang.label}
                          </button>
                        );
                      })}
                    </div>
                    {preferredSubtitles.length === 0 && (
                      <p className="text-[11px] text-[#505050] pb-1">All available subtitles will be downloaded</p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

          {/* ── Downloads ────────────────────────────────────── */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.2, ease: 'easeOut' }} className="mt-6">
            <SectionHeader title="Downloads" />
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06] px-4">
              <SettingsRow
                icon={<FolderOpen className="size-[18px]" />}
                label="Download Location"
                value={downloadFolderName || 'In-app storage (IndexedDB)'}
                subtitle={downloadFolderName ? 'Auto-save enabled' : 'Tap to choose a folder for auto-save'}
                iconColor="#FF9800"
                onClick={handleChooseDownloadFolder}
                endAdornment={isPickingFolder ? <Loader2 className="size-4 animate-spin text-[#808080]" /> : undefined}
              />
              {downloadFolderName && (
                <>
                  <div className="h-px bg-white/[0.06] ml-[52px]" />
                  <SettingsRow
                    icon={<FolderOpen className="size-[18px]" />}
                    label="Reset to In-App Storage"
                    subtitle="Stop auto-saving to folder, use IndexedDB only"
                    iconColor="#808080"
                    onClick={async () => {
                      const { removeDirectoryHandle } = await import('@/lib/download-storage');
                      await removeDirectoryHandle();
                      setDownloadFolderName(null);
                      toast.success('Download location reset');
                    }}
                  />
                </>
              )}
            </div>
          </motion.div>

          {/* ── Admin Hub ──────────────────────────────────── */}
          <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.2, ease: 'easeOut' }} className="mt-6">
            <SectionHeader title="Admin Hub" />
            <div className="rounded-2xl bg-white/[0.03] border border-white/[0.06]">
              {/* Section header bar */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
                <div className="flex items-center gap-2">
                  <Users className="size-4 text-sv-red" />
                  <span className="text-[13px] font-medium text-[#F5F5F5]">All Users</span>
                  {!isLoadingUsers && (
                    <span className="text-[11px] text-[#606060] bg-white/[0.06] px-2 py-0.5 rounded-full">{allUsers.length}</span>
                  )}
                </div>
                {isLoadingUsers && <Loader2 className="size-4 text-[#606060] animate-spin" />}
              </div>

              {/* Users list */}
              <div className="max-h-[520px] overflow-y-auto">
                {allUsers.length === 0 && !isLoadingUsers && (
                  <div className="flex flex-col items-center py-8 text-center">
                    <Users className="size-8 text-[#404040] mb-2" />
                    <p className="text-sm text-[#606060]">No users found</p>
                  </div>
                )}
                {allUsers.map((u) => {
                  const userInitials = u.name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
                  const isMe = user?.id === u.id;
                  const isSelected = expandedUserId === u.id;
                  // Cross-reference API data with local store for party membership.
                  // API data can be stale; local store reflects the current party in real-time.
                  const isInLocalParty = currentParty?.members.some((m) => m.userId === u.id) ?? false;
                  const userInParty = !!u.party || isInLocalParty;
                  return (
                    <div
                      key={u.id}
                      onClick={() => setExpandedUserId(isSelected ? null : u.id)}
                      className={`flex items-center gap-4 px-5 py-4 transition-colors cursor-pointer ${isSelected ? 'bg-white/[0.04]' : 'hover:bg-white/[0.03]'}`}
                    >
                      {/* Avatar + status dot */}
                      <div className="relative flex-shrink-0">
                        <div
                          className="rounded-full overflow-hidden border"
                          style={{ borderColor: isSelected ? 'rgba(217, 119, 6, 0.4)' : 'rgba(255,255,255,0.08)', width: 56, height: 56 }}
                        >
                          {u.avatar_url ? (
                            <img src={u.avatar_url} alt={u.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full bg-[#1a1a1a] flex items-center justify-center text-[15px] font-bold text-sv-red">{userInitials || '?'}</div>
                          )}
                        </div>
                      </div>

                      {/* Name + role */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[16px] font-medium text-[#F5F5F5] truncate">{u.name}</span>
                          {u.role === 'admin' && <Crown className="size-3.5 text-yellow-500 flex-shrink-0" />}
                          {isMe && (
                            <span className="text-[10px] text-[#808080] bg-white/[0.06] px-1.5 py-0.5 rounded-full flex-shrink-0">You</span>
                          )}
                        </div>
                        <p className="text-[13px] text-[#505050]">
                          {userInParty
                            ? (u.party?.memberStatus === 'invited'
                              ? 'Pending invite'
                              : (u.party?.partyTitle
                                ? `In a party · ${u.party.partyTitle}`
                                : 'In a watch party'))
                            : null}
                        </p>
                      </div>

                      {/* Party badge + Invite button */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {userInParty && (
                          <span className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-full ${
                            u.party?.memberStatus === 'invited'
                              ? 'text-yellow-500 bg-yellow-500/10 border border-yellow-500/20'
                              : 'text-sv-red bg-sv-red/10 border border-sv-red/20'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                              u.party?.memberStatus === 'invited' ? 'bg-yellow-500' : 'bg-sv-red'
                            }`} />
                            {u.party?.memberStatus === 'invited' ? 'Invited' : 'In Party'}
                          </span>
                        )}
                        {isMe && isHost && isInParty && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleEndParty(); }}
                            disabled={isEndingParty}
                            className="flex items-center gap-1 text-[11px] font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/30 px-2 py-1 rounded-full transition-all cursor-pointer press-effect disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {isEndingParty ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <X className="size-3" />
                            )}
                            {isEndingParty ? 'Ending...' : 'End Party'}
                          </button>
                        )}
                        {!isMe && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleInviteToWatchParty(u.id); }}
                            disabled={isInviting === u.id || userInParty}
                            className="flex items-center gap-1 text-[13px] font-medium text-[#A0A0A0] hover:text-sv-red bg-white/[0.04] hover:bg-sv-red/10 border border-white/[0.06] hover:border-sv-red/20 px-3 py-2 rounded-lg transition-all cursor-pointer press-effect disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {isInviting === u.id ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Plus className="size-3.5" />
                            )}
                            {isInviting === u.id ? 'Inviting...' : (userInParty ? (u.party?.memberStatus === 'invited' ? 'Pending' : 'In Party') : 'Invite')}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </motion.div>

          {/* ── Fullscreen Photo Viewer (Instagram-style) ─── */}
          <AnimatePresence>
            {expandedUserId && (() => {
              const u = allUsers.find((u) => u.id === expandedUserId);
              if (!u) return null;
              const userInitials = u.name.split(' ').filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
              const isMe = user?.id === u.id;
              return (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  onClick={() => setExpandedUserId(null)}
                  className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
                >
                  {/* Close button */}
                  <button
                    onClick={(e) => { e.stopPropagation(); setExpandedUserId(null); }}
                    className="absolute top-4 right-4 w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-colors cursor-pointer z-10"
                  >
                    <X className="size-5 text-white" />
                  </button>

                  {/* Photo + info */}
                  <motion.div
                    initial={{ scale: 0.7, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.7, opacity: 0 }}
                    transition={{ type: 'spring', stiffness: 300, damping: 28 }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex flex-col items-center gap-5 px-8"
                  >
                    {/* Large avatar */}
                    <div className="relative">
                      <div className="w-48 h-48 sm:w-56 sm:h-56 rounded-full overflow-hidden border-2 border-white/[0.12] shadow-2xl shadow-black/50">
                        {u.avatar_url ? (
                          <img src={u.avatar_url} alt={u.name} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full bg-[#1a1a1a] flex items-center justify-center text-4xl font-bold text-sv-red">{userInitials || '?'}</div>
                        )}
                      </div>
                    </div>

                    {/* Name + badges */}
                    <div className="text-center">
                      <div className="flex items-center justify-center gap-2">
                        <h2 className="text-xl font-bold text-white">{u.name}</h2>
                        {u.role === 'admin' && <Crown className="size-5 text-yellow-500" />}
                      </div>
                      {isMe && (
                        <span className="inline-block mt-1 text-[11px] text-[#808080] bg-white/[0.08] px-2 py-0.5 rounded-full">You</span>
                      )}
                    </div>
                  </motion.div>
                </motion.div>
              );
            })()}
          </AnimatePresence>

          {/* ── Sign Out ─────────────────────────────────── */}
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.3 }} className="mt-8">
            <button onClick={handleLogout} disabled={isLoggingOut} className="w-full flex items-center justify-center gap-2 bg-white/[0.03] border border-white/[0.06] hover:bg-sv-red/10 hover:border-sv-red/20 disabled:opacity-50 text-[#A0A0A0] hover:text-sv-red font-medium py-3 rounded-2xl transition-colors cursor-pointer press-effect">
              {isLoggingOut ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
              {isLoggingOut ? 'Signing out...' : 'Sign Out'}
            </button>
          </motion.div>

          {/* ── Footer ──────────────────────────────────── */}
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.35 }} className="flex flex-col items-center mt-6 mb-4">
            <div className="flex items-center gap-1.5 mb-1">
              <RetroShield className="size-4" style={{ color: '#D97706' }} strokeWidth={1.5} />
              <span className="text-sm font-bold tracking-[0.1em] uppercase" style={{ color: '#D97706' }}>StreamVault</span>
            </div>
          </motion.div>
        </>
      )}
    </div>
  );
}
