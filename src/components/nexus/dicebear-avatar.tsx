"use client";

import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { generateAvatarSeed } from "@/lib/avatar";

// ====================================================================
// DiceBear Avatar — generates a neutral, gender-free avatar from a name.
// Uses the "shapes" style which produces abstract geometric avatars
// (no human features, no gender cues).
//
// The seed is always auto-generated from the name hash — callers should
// NOT pass a seed. This ensures consistency and privacy.
// ====================================================================

interface AvatarProps {
  fullName: string;
  size?: number;
  className?: string;
}

export function DiceBearAvatar({ fullName, size = 32, className = "" }: AvatarProps) {
  // Always auto-generate from name hash — neutral and consistent
  const avatarSeed = generateAvatarSeed(fullName);
  // "shapes" style = abstract geometric patterns, no human/gender features
  const avatarUrl = `https://api.dicebear.com/7.x/shapes/svg?seed=${encodeURIComponent(avatarSeed)}&backgroundColor=fef3c7,fde68a,fcd34d,fbbf24,f59e0b&backgroundType=gradientLinear&radius=50`;

  const initials = fullName
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <Avatar
      className={className}
      style={{ width: size, height: size, minWidth: size, minHeight: size }}
    >
      <AvatarImage
        src={avatarUrl}
        alt={fullName}
        className="object-cover"
      />
      <AvatarFallback
        className="bg-primary/20 text-primary"
        style={{ width: size, height: size, fontSize: `${Math.max(10, size * 0.35)}px` }}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}
