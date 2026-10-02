import { agentAvatarUrl } from "@/lib/agent-avatar-url";
import { useState } from "react";
import { resolveAgentAppearance, type AgentAppearance, type AgentAvatarSize, type CharacterState } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { deriveInitials } from "./Identity";

export type AvatarAgent = { id?: string; name?: string; appearance?: AgentAppearance | null; avatarUrl?: string | null };
export const avatarSizeClasses: Record<AgentAvatarSize, string> = {
  16: "size-4", 20: "size-5", 24: "size-6", 32: "size-8", 40: "size-10", 48: "size-12",
  64: "size-16", 96: "size-24", 128: "size-32", 256: "size-64", 512: "size-128",
};
export interface AgentAvatarProps {
  agent?: AvatarAgent | null;
  appearance?: AgentAppearance | null;
  size?: AgentAvatarSize;
  name?: string;
  label?: string;
  pose?: CharacterState;
  muted?: boolean;
  className?: string;
}
/** The server flags an operator theme that ships its own avatar artwork. */
export function hasThemeAvatars() {
  return typeof document !== "undefined" && document.querySelector('meta[name="paperclip-ui-theme-avatars"]') !== null;
}
export function AgentAvatar({ agent, appearance, size = 24, name, label, pose = "rest", muted = false, className }: AgentAvatarProps) {
  const identity = resolveAgentAppearance(appearance ?? agent?.appearance, agent?.id);
  // Theme artwork loads from its own path: the PNG avatar URLs are cached as immutable, so a palette
  // a browser has already seen would keep showing the built-in character. A missing file falls back to it.
  const themed = hasThemeAvatars() ? `/ui-theme/avatars/${muted ? "muted-dream" : identity.paletteId}/${pose}.svg` : null;
  const [themeFailed, setThemeFailed] = useState(false);
  const src = themed && !themeFailed ? themed : agentAvatarUrl(identity, size, 1, pose, muted);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span data-slot="agent-avatar" className={cn("relative inline-flex shrink-0 items-center justify-center align-middle", avatarSizeClasses[size], className)}
      role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {failedUrl === src ? <span className="text-xs text-muted-foreground">{deriveInitials(name ?? agent?.name ?? "Agent")}</span> :
        <img src={src} srcSet={src === themed ? undefined : `${agentAvatarUrl(identity, size, 2, pose, muted)} 2x`} alt="" width={size} height={size}
          decoding="async" loading="lazy" className="size-full object-contain" onError={() => src === themed ? setThemeFailed(true) : setFailedUrl(src)} />}
    </span>
  );
}
