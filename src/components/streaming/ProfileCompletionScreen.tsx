'use client';

import { useState, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { ArrowRight, Camera, Check, Loader2, User } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { supabase, uploadAvatar, upsertMyProfile } from '@/lib/supabase';
import { compressImage } from '@/lib/image-utils';
import { useAuthStore, useSettingsStore } from '@/store';

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

export default function ProfileCompletionScreen() {
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);
  const setProfile = useAuthStore((s) => s.setProfile);
  const setStatus = useAuthStore((s) => s.setStatus);

  const [name, setName] = useState('');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isAvatarLoading, setIsAvatarLoading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const preferredSubtitles = useSettingsStore((s) => s.preferredSubtitles);
  const togglePreferredSubtitle = useSettingsStore((s) => s.togglePreferredSubtitle);

  const userId = user?.id;
  const isFormValid = name.trim().length >= 2 && !!avatarPreview;

  // ── Avatar ─────────────────────────────────────────────

  const handleAvatarClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleAvatarChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please select an image'); e.target.value = ''; return; }
    if (file.size > AVATAR_MAX_FILE_SIZE) { toast.error('Image must be under 5 MB'); e.target.value = ''; return; }

    setIsAvatarLoading(true);
    try {
      const compressed = await compressImage(file);
      setAvatarPreview(compressed);
    } catch {
      toast.error('Failed to process image');
    } finally {
      setIsAvatarLoading(false);
    }
    e.target.value = '';
  }, []);

  // ── Submit ─────────────────────────────────────────────

  const handleComplete = useCallback(async () => {
    if (!avatarPreview) {
      setError('Please add a profile photo');
      return;
    }
    if (name.trim().length < 2 || !userId) {
      setError('Name must be at least 2 characters');
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      let avatarUrl: string | null = null;

      // Upload avatar if one was selected
      if (avatarPreview) {
        // Convert data URL back to File for upload
        const res = await fetch(avatarPreview);
        const blob = await res.blob();
        const file = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });

        avatarUrl = await uploadAvatar(userId, file);
        if (!avatarUrl) {
          toast.error('Failed to upload avatar. You can set it later in profile.');
        }
      }

      // Upsert profile in Supabase via authed client (handles RLS correctly)
      const updatedProfile = await upsertMyProfile(userId, {
        id: userId,
        email: user?.email || '',
        display_name: name.trim(),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        role: 'vip',
      });

      if (!updatedProfile) {
        toast.error('Failed to save profile');
        return;
      }

      // Mark profile as completed in user metadata — this flag persists
      // across data clears and bypasses RLS on the profiles table.
      supabase.auth.updateUser({ data: { profile_completed: true } }).catch(() => {});

      setProfile(updatedProfile);
      setStatus('authenticated');
      toast.success('Welcome to StreamVault!');
    } catch {
      toast.error('Connection error');
    } finally {
      setIsSubmitting(false);
    }
  }, [name, avatarPreview, userId, isFormValid, setProfile, setStatus]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isFormValid && !isSubmitting) handleComplete();
  }, [handleComplete, isFormValid, isSubmitting]);

  const initials = name
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex items-center justify-center min-h-full px-6">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="w-full max-w-sm flex flex-col items-center"
      >
        <h2 className="text-xl font-bold text-[#F5F5F5] mb-1">Complete Your Profile</h2>
        <p className="text-sm text-[#808080] mb-8 text-center">
          Set your name and add a photo to get started.
        </p>

        {/* Hidden file input */}
        <input
          type="file"
          ref={fileInputRef}
          accept="image/jpeg,image/png,image/webp"
          onChange={handleAvatarChange}
          className="hidden"
        />

        {/* Avatar picker */}
        <div className="relative mb-6" onClick={handleAvatarClick}>
          <div className="w-[100px] h-[100px] rounded-full overflow-hidden border-2 border-dashed border-white/20 cursor-pointer transition-all duration-300 hover:border-sv-red/50">
            <Avatar className="w-full h-full">
              <AvatarImage src={avatarPreview || undefined} alt="Avatar" className="object-cover" />
              <AvatarFallback className="text-2xl font-bold bg-[#1a1a1a] text-[#404040]">
                {initials || <User className="size-8" />}
              </AvatarFallback>
            </Avatar>
          </div>
          {isAvatarLoading ? (
            <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
              <Loader2 className="size-6 text-white animate-spin" />
            </div>
          ) : (
            <div className="absolute inset-0 rounded-full bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity cursor-pointer">
              <Camera className="size-6 text-white" />
            </div>
          )}
        </div>
        <p className="text-[11px] text-[#606060] mb-6">Tap to add a photo <span className="text-sv-red">*</span></p>

        {/* Name input */}
        <div className="w-full">
          <label htmlFor="profile-name" className="sr-only">Your name</label>
          <input
            id="profile-name"
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            autoFocus
            maxLength={NAME_MAX_LENGTH}
            placeholder="Your name"
            disabled={isSubmitting}
            className="w-full bg-white/[0.06] border border-white/[0.12] rounded-xl px-4 py-3.5 text-[15px] text-[#F5F5F5] placeholder:text-[#505050] outline-none focus:border-sv-red/50 transition-colors text-center disabled:opacity-50"
          />
          {error && <p className="text-xs text-sv-red mt-2 text-center">{error}</p>}
        </div>

        {/* Preferred Offline Subtitles */}
        <div className="w-full mt-5">
          <p className="text-sm text-[#808080] mb-2 text-center">Offline Subtitles</p>
          <p className="text-[11px] text-[#505050] mb-3 text-center">Choose languages to auto-download with videos</p>
          <div className="flex flex-wrap justify-center gap-2">
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
            <p className="text-[11px] text-[#505050] mt-2 text-center">All available subtitles will be downloaded</p>
          )}
        </div>

        {/* Submit */}
        <button
          onClick={handleComplete}
          disabled={!isFormValid || isSubmitting || !avatarPreview}
          className="mt-6 flex items-center gap-2 bg-sv-red hover:bg-sv-red-hover disabled:opacity-30 disabled:hover:bg-sv-red text-white font-semibold px-8 py-3.5 rounded-xl transition-colors cursor-pointer press-effect"
        >
          {isSubmitting ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <>
              Continue
              <ArrowRight className="size-4" />
            </>
          )}
        </button>

        {/* Skip avatar note */}
        <p className="text-[11px] text-[#505050] mt-4 text-center">
          {profile?.email && `Signed in as ${profile.email}`}
        </p>
      </motion.div>
    </div>
  );
}
