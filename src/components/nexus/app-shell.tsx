"use client";

import { useMemo, useState } from "react";
import {
  LayoutDashboard,
  Users,
  CalendarDays,
  QrCode,
  ScanLine,
  ClipboardList,
  AlertTriangle,
  ShieldCheck,
  LogOut,
  Wifi,
  WifiOff,
  ShieldAlert,
  ScrollText,
  HelpCircle,
  FileText,
  Menu,
  X,
  Bug,
  UserCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useLogout, type Account } from "@/lib/api-client";
import { ROLE_LABELS } from "@/lib/rbac";
import { toast } from "@/hooks/use-toast";
import { ThemeToggle } from "./theme-toggle";
import { CookieConsent } from "./cookie-consent";
import { InfoModals, openInfoModal } from "./info-modals";
import { DiceBearAvatar } from "./dicebear-avatar";
import { NexusLogo } from "./nexus-logo";
import { NotificationBell } from "./notification-bell";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { DashboardView } from "./views/dashboard";
import { WhitelistView } from "./views/whitelist";
import { EventsView } from "./views/events";
import { ProjectQrView } from "./views/project-qr";
import { ScannerView } from "./views/scanner";
import { AttendanceView } from "./views/attendance";
import { OverridesView } from "./views/overrides";
import { AccountsView } from "./views/accounts";
import { AuditLogsView } from "./views/audit-logs";
import { ProfileView } from "./views/profile";

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
  | "profile";

interface NavItem {
  id: ViewId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles: Array<Account["role"]>;
  description: string;
}

const NAV: NavItem[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    roles: ["ADMIN", "ORGANIZER", "USER"],
    description: "Overview",
  },
  {
    id: "whitelist",
    label: "Students",
    icon: Users,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Approved students",
  },
  {
    id: "events",
    label: "Events",
    icon: CalendarDays,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Classes and events",
  },
  {
    id: "project-qr",
    label: "Project QR",
    icon: QrCode,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Show QR code",
  },
  {
    id: "scanner",
    label: "Scanner",
    icon: ScanLine,
    roles: ["USER"],
    description: "Check in",
  },
  {
    id: "attendance",
    label: "Attendance",
    icon: ClipboardList,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Who's present",
  },
  {
    id: "overrides",
    label: "Overrides",
    icon: AlertTriangle,
    roles: ["ADMIN", "ORGANIZER"],
    description: "Add manually",
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: ShieldAlert,
    roles: ["ADMIN"],
    description: "Manage users",
  },
  {
    id: "audit-logs",
    label: "Activity Log",
    icon: ScrollText,
    roles: ["ADMIN"],
    description: "All actions",
  },
  {
    id: "profile",
    label: "Profile",
    icon: UserCircle,
    roles: ["ORGANIZER", "USER"],
    description: "Your account",
  },
];

export function AppShell({ user }: { user: Account }) {
  const [view, setView] = useState<ViewId>("dashboard");
  const logout = useLogout();
  const online = useOnlineStatus();

  const allowedNav = useMemo(
    () => NAV.filter((n) => n.roles.includes(user.role)),
    [user.role],
  );
  const activeView: ViewId = allowedNav.some((n) => n.id === view)
    ? view
    : "dashboard";

  function handleLogout() {
    logout.mutate(undefined, {
      onSuccess: () => {
        toast({ title: "Signed out" });
        // Force a full page reload to clear all in-memory state and ensure
        // the login screen shows. Without this, React Query cache clearing
        // may not fully reset the NextAuth session on Google OAuth users.
        setTimeout(() => (window.location.href = "/"), 500);
      },
    });
  }

  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex flex-1 min-h-0">
        <aside className="hidden md:flex w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
          <div className="p-4 flex items-center gap-3">
            <NexusLogo size={40} />
            <div className="min-w-0">
              <p className="font-semibold tracking-tight leading-tight truncate">
                Nexus Gate
              </p>
              <p className="text-[11px] text-sidebar-foreground/60 truncate">
                Attendance System
              </p>
            </div>
          </div>
          <Separator className="bg-sidebar-border" />
          <nav className="flex-1 p-3 space-y-1 overflow-y-auto ng-scroll">
            {allowedNav.map((item) => {
              const Icon = item.icon;
              const active = activeView === item.id;
              return (
                <TooltipProvider key={item.id}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setView(item.id)}
                        className={`w-full group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                          active
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                        }`}
                      >
                        <Icon
                          className={`h-4 w-4 shrink-0 ${active ? "text-primary" : "text-sidebar-foreground/60 group-hover:text-primary"}`}
                        />
                        <span className="flex-1 text-left font-medium">
                          {item.label}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="right">
                      {item.description}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              );
            })}
          </nav>
          <Separator className="bg-sidebar-border" />
          <div className="p-3 space-y-2">
            <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-sidebar-accent/40">
              <DiceBearAvatar fullName={user.fullName} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{user.fullName}</p>
                <p className="text-[10px] text-sidebar-foreground/60 truncate">
                  {ROLE_LABELS[user.role]}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openInfoModal("bug")}
              className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
            >
              <Bug className="h-4 w-4" /> Report a bug
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
            >
              <LogOut className="h-4 w-4" /> Sign out
            </Button>
          </div>
        </aside>

        <div className="flex-1 flex flex-col min-w-0">
          <header className="sticky top-0 z-20 h-14 border-b bg-background/80 backdrop-blur px-4 flex items-center gap-3">
            <MobileNav
              allowedNav={allowedNav}
              activeView={activeView}
              onSelect={setView}
              onLogout={handleLogout}
            />
            <div className="flex-1 min-w-0">
              <h2 className="text-sm font-semibold truncate">
                {NAV.find((n) => n.id === activeView)?.label}
              </h2>
              <p className="text-[11px] text-muted-foreground truncate">
                {NAV.find((n) => n.id === activeView)?.description}
              </p>
            </div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    className={`gap-1.5 ${online ? "border-emerald-500/40 text-emerald-600" : "border-amber-500/40 text-amber-600"}`}
                  >
                    {online ? (
                      <Wifi className="h-3 w-3" />
                    ) : (
                      <WifiOff className="h-3 w-3" />
                    )}
                    <span className="hidden sm:inline">
                      {online ? "Online" : "Offline"}
                    </span>
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {online
                    ? "Connected"
                    : "Offline — scans are saved and sent later"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <NotificationBell />
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 lg:hidden"
              onClick={() => openInfoModal("faq")}
            >
              <HelpCircle className="h-4 w-4" />
            </Button>
            <ThemeToggle />
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {ROLE_LABELS[user.role]}
            </Badge>
          </header>

          <main className="flex-1 overflow-y-auto ng-scroll">
            <div className="p-4 sm:p-6 max-w-7xl mx-auto w-full">
              {activeView === "dashboard" && (
                <DashboardView user={user} onNavigate={setView} />
              )}
              {activeView === "whitelist" && <WhitelistView />}
              {activeView === "events" && <EventsView />}
              {activeView === "project-qr" && <ProjectQrView />}
              {activeView === "scanner" && (
                <ScannerView user={user} onNavigate={setView} />
              )}
              {activeView === "attendance" && <AttendanceView />}
              {activeView === "overrides" && <OverridesView />}
              {activeView === "accounts" && <AccountsView currentUser={user} />}
              {activeView === "audit-logs" && <AuditLogsView />}
              {activeView === "profile" && <ProfileView />}
            </div>
          </main>
        </div>
      </div>
      <CookieConsent />
      <InfoModals />
    </div>
  );
}

function MobileNav({
  allowedNav,
  activeView,
  onSelect,
  onLogout,
}: {
  allowedNav: NavItem[];
  activeView: ViewId;
  onSelect: (v: ViewId) => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9"
        onClick={() => setOpen(true)}
      >
        <Menu className="h-5 w-5" />
      </Button>
      {open && (
        <div
          className="fixed inset-0 h-[100dvh] z-50 bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="absolute left-0 top-0 h-full w-72 max-w-[80vw] bg-sidebar/95 backdrop-blur-xl text-sidebar-foreground border-r border-sidebar-border shadow-2xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 flex items-center justify-between border-b border-sidebar-border">
              <div className="flex items-center gap-2.5">
                <NexusLogo size={36} />
                <div>
                  <p className="font-heading font-semibold text-sm">
                    Nexus Gate
                  </p>
                  <p className="text-[10px] text-sidebar-foreground/60">
                    Attendance System
                  </p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-sidebar-foreground/60 hover:text-sidebar-foreground"
                onClick={() => setOpen(false)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto ng-scroll">
              {allowedNav.map((item) => {
                const Icon = item.icon;
                const active = activeView === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      onSelect(item.id);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"}`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${active ? "text-primary" : "text-sidebar-foreground/60"}`}
                    />
                    <span className="font-medium">{item.label}</span>
                  </button>
                );
              })}
            </nav>
            {/* Logout + bug report — matches desktop sidebar */}
            <div className="p-3 border-t border-sidebar-border space-y-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  openInfoModal("bug");
                  setOpen(false);
                }}
                className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
              >
                <Bug className="h-4 w-4" /> Report a bug
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onLogout();
                  setOpen(false);
                }}
                className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
