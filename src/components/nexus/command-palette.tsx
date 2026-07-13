"use client";

import { useEffect, useState, useCallback } from "react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  QrCode,
  ScanLine,
  ClipboardList,
  AlertTriangle,
  ShieldAlert,
  ScrollText,
  UserCircle,
  CalendarRange,
  History,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { Account } from "@/lib/api-client";

type ViewId =
  | "dashboard"
  | "whitelist"
  | "events"
  | "project-qr"
  | "scanner"
  | "attendance"
  | "overrides"
  | "accounts"
  | "audit-logs"
  | "profile"
  | "calendar"
  | "my-attendance";

interface NavCommand {
  label: string;
  description: string;
  icon: LucideIcon;
  view: ViewId;
  keywords: string;
  shortcut?: string;
}

// Build the command list based on the user's role.
function getCommands(role: string): NavCommand[] {
  const commands: NavCommand[] = [
    {
      label: "Dashboard",
      description: "Overview and stats",
      icon: LayoutDashboard,
      view: "dashboard",
      keywords: "home overview stats",
    },
  ];

  if (role === "ADMIN" || role === "ORGANIZER") {
    commands.push(
      {
        label: "Students",
        description: "Manage approved student list",
        icon: Users,
        view: "whitelist",
        keywords: "whitelist roster students import",
      },
      {
        label: "Events",
        description: "Create and manage events",
        icon: CalendarDays,
        view: "events",
        keywords: "classes create schedule",
      },
      {
        label: "Calendar",
        description: "Monthly calendar view",
        icon: CalendarRange,
        view: "calendar",
        keywords: "month schedule dates",
      },
      {
        label: "Project QR",
        description: "Show the live QR code",
        icon: QrCode,
        view: "project-qr",
        keywords: "display projector screen",
      },
      {
        label: "Attendance",
        description: "See who's present",
        icon: ClipboardList,
        view: "attendance",
        keywords: "roster check-in present",
      },
    );
  }

  // Overrides are ADMIN-only (restricted for data integrity).
  if (role === "ADMIN") {
    commands.push({
      label: "Overrides",
      description: "Add attendance manually",
      icon: AlertTriangle,
      view: "overrides",
      keywords: "manual entry override add",
    });
  }

  if (role === "USER") {
    commands.push(
      {
        label: "Scanner",
        description: "Scan QR to check in",
        icon: ScanLine,
        view: "scanner",
        keywords: "camera check-in scan qr",
        shortcut: "S",
      },
      {
        label: "My Attendance",
        description: "View your check-in history",
        icon: History,
        view: "my-attendance",
        keywords: "history records past",
      },
    );
  }

  if (role === "ADMIN") {
    commands.push(
      {
        label: "Accounts",
        description: "Manage user accounts",
        icon: ShieldAlert,
        view: "accounts",
        keywords: "users manage admin suspend",
      },
      {
        label: "Activity Log",
        description: "View audit trail",
        icon: ScrollText,
        view: "audit-logs",
        keywords: "audit log actions history",
      },
    );
  }

  if (role === "ORGANIZER" || role === "USER") {
    commands.push({
      label: "Profile",
      description: "Manage your account",
      icon: UserCircle,
      view: "profile",
      keywords: "settings account password passkey",
    });
  }

  return commands;
}

export function CommandPalette({
  user,
  onNavigate,
}: {
  user: Account;
  onNavigate: (v: ViewId) => void;
}) {
  const [open, setOpen] = useState(false);

  // Listen for Cmd+K / Ctrl+K to toggle the palette, and a custom event
  // from the header search button.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", handler);
    const openHandler = () => setOpen(true);
    window.addEventListener("nexus-open-command-palette", openHandler);
    return () => {
      document.removeEventListener("keydown", handler);
      window.removeEventListener("nexus-open-command-palette", openHandler);
    };
  }, []);

  const handleSelect = useCallback(
    (view: ViewId) => {
      setOpen(false);
      onNavigate(view);
    },
    [onNavigate],
  );

  const commands = getCommands(user.role);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Quick navigation"
      description="Search for a page or action..."
    >
      <CommandInput placeholder="Type a page name or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {commands.map((cmd) => {
            const Icon = cmd.icon;
            return (
              <CommandItem
                key={cmd.view}
                value={`${cmd.label} ${cmd.keywords}`}
                onSelect={() => handleSelect(cmd.view)}
                className="gap-2"
              >
                <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{cmd.label}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {cmd.description}
                  </span>
                </div>
                {cmd.shortcut && (
                  <kbd className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded border">
                    {cmd.shortcut}
                  </kbd>
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Help">
          <CommandItem
            onSelect={() => {
              setOpen(false);
              window.open("/faq", "_self");
            }}
            className="gap-2"
          >
            <Settings className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="text-sm">FAQ & Help</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
