"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  ShieldAlert,
  Search,
  Ban,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  UserPlus,
  Loader2,
  Mail,
  Lock,
  Hash,
  Pencil,
  ShieldCheck,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ConfirmDialog } from "@/components/nexus/confirm-dialog";
import { DiceBearAvatar } from "@/components/nexus/dicebear-avatar";
import {
  useAccounts,
  useUpdateAccount,
  useAdminCreateAccount,
  useDeleteAccount,
  type Account,
} from "@/lib/api-client";
import { ROLE_LABELS } from "@/lib/rbac";
import { PROGRAMS, getProgramLabel } from "@/lib/programs";
import { toast } from "@/hooks/use-toast";
import { format } from "date-fns";

const STATUS_LABELS: Record<Account["status"], string> = {
  PENDING_VERIFICATION: "Pending",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
};

type PendingAction = {
  account: Account;
  value: "SUSPENDED" | "ACTIVE";
};

type DeleteTarget = {
  account: Account;
  hard: boolean;
};

// Editable fields for the admin's edit dialog. Mirrors useUpdateAccount's
// payload shape, but with string/Select-friendly defaults (e.g. `"__none__"`
// sentinel for the program dropdown).
type EditTarget = {
  account: Account;
  fullName: string;
  email: string;
  program: string; // "" or "__none__" = no program
  section: string;
  year: number;
  role: Account["role"];
  status: Account["status"];
  organizationName: string;
};

export function AccountsView({ currentUser }: { currentUser?: Account }) {
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [sortBy, setSortBy] = useState<string>("created-desc");
  const [page, setPage] = useState(1);
  const { data, isLoading, isError } = useAccounts({
    q: q || undefined,
    role: roleFilter === "ALL" ? undefined : roleFilter,
    page,
  });
  const updateMut = useUpdateAccount();
  const createMut = useAdminCreateAccount();
  const deleteMut = useDeleteAccount();

  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  // Create form state
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newFullName, setNewFullName] = useState("");
  const [newRole, setNewRole] = useState<"ADMIN" | "ORGANIZER">("ORGANIZER");
  const [newProgram, setNewProgram] = useState("");
  const [newSection, setNewSection] = useState("");
  const [newOrgName, setNewOrgName] = useState("");
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});

  const rawAccounts = data?.accounts ?? [];
  // Apply client-side status filter + sorting
  const accounts = rawAccounts
    .filter((a) => statusFilter === "ALL" || a.status === statusFilter)
    .sort((a, b) => {
      switch (sortBy) {
        case "created-asc":
          return (
            new Date(a.createdAt || 0).getTime() -
            new Date(b.createdAt || 0).getTime()
          );
        case "name-asc":
          return a.fullName.localeCompare(b.fullName);
        case "name-desc":
          return b.fullName.localeCompare(a.fullName);
        case "lastlogin-desc":
          return (
            new Date(b.lastLoginAt || 0).getTime() -
            new Date(a.lastLoginAt || 0).getTime()
          );
        default:
          return (
            new Date(b.createdAt || 0).getTime() -
            new Date(a.createdAt || 0).getTime()
          ); // created-desc
      }
    });
  const pagination = data?.pagination;

  async function confirmAction() {
    if (!pendingAction) return;
    const { account, value } = pendingAction;
    await updateMut.mutateAsync(
      { id: account.id, status: value },
      {
        onSuccess: () => {
          toast({
            title:
              value === "SUSPENDED"
                ? "Account suspended"
                : "Account reactivated",
            description:
              value === "SUSPENDED"
                ? `${account.fullName} can no longer sign in.`
                : `${account.fullName} can sign in again.`,
          });
        },
        onError: (e) =>
          toast({
            title: "Couldn't update account",
            description: e.message,
            variant: "destructive",
          }),
      },
    );
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await deleteMut.mutateAsync(deleteTarget.account.id);
      toast({
        title: "Account deleted",
        description: `${deleteTarget.account.fullName} and all related data have been removed.`,
      });
    } catch (e) {
      toast({
        title: "Could not delete account",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  }

  function openEdit(a: Account) {
    setEditTarget({
      account: a,
      fullName: a.fullName,
      email: a.email,
      program: a.program ?? "__none__",
      section: a.section ?? "",
      year: a.year ?? 1,
      role: a.role,
      status: a.status,
      organizationName: a.organizationName ?? "",
    });
  }

  async function saveEdit() {
    if (!editTarget) return;
    const {
      account,
      fullName,
      email,
      program,
      section,
      year,
      role,
      status,
      organizationName,
    } = editTarget;
    await updateMut.mutateAsync(
      {
        id: account.id,
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        role,
        status,
        program: program === "__none__" ? null : program,
        section: section.trim() || null,
        year: role === "USER" ? year : null,
        organizationName:
          role === "ORGANIZER" ? organizationName.trim() || null : null,
      },
      {
        onSuccess: () => {
          toast({
            title: "Account updated",
            description: `${fullName}'s details have been saved.`,
          });
          setEditTarget(null);
        },
        onError: (e) =>
          toast({
            title: "Couldn't update account",
            description: e.message,
            variant: "destructive",
          }),
      },
    );
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!newFullName.trim()) errs.fullName = "Name is required";
    if (!newEmail.trim()) errs.email = "Email is required";
    // Password: match backend passwordSchema rules.
    if (newPassword.length < 8) {
      errs.password = "Min 8 characters";
    } else if (!/[A-Z]/.test(newPassword)) {
      errs.password = "Include an uppercase letter";
    } else if (!/[a-z]/.test(newPassword)) {
      errs.password = "Include a lowercase letter";
    } else if (!/[0-9]/.test(newPassword)) {
      errs.password = "Include a number";
    } else if (!/[^A-Za-z0-9]/.test(newPassword)) {
      errs.password = "Include a special character (!@#$...)";
    }
    // Section: must be <digits>-<letters> format if provided.
    if (newSection.trim() && !/^\d+-[A-Za-z]+$/.test(newSection.trim())) {
      errs.section = "Format: <year>-<letter> (e.g. 2-A)";
    }
    setCreateErrors(errs);
    if (Object.keys(errs).length > 0) return;

    createMut.mutate(
      {
        email: newEmail.trim().toLowerCase(),
        password: newPassword,
        fullName: newFullName.trim(),
        role: newRole,
        program: newProgram.trim() || undefined,
        section: newSection.trim() || undefined,
        organizationName:
          newRole === "ORGANIZER" ? newOrgName.trim() || undefined : undefined,
      },
      {
        onSuccess: () => {
          toast({
            title: "Account created",
            description: `${newFullName} (${newRole === "ADMIN" ? "Administrator" : "Organizer"}) can now sign in with their email and password.`,
          });
          setCreateOpen(false);
          setNewEmail("");
          setNewPassword("");
          setNewFullName("");
          setNewRole("ORGANIZER");
          setNewProgram("");
          setNewSection("");
          setNewOrgName("");
          setCreateErrors({});
        },
        onError: (e) =>
          toast({
            title: "Could not create account",
            description: e.message,
            variant: "destructive",
          }),
      },
    );
  }

  return (
    <div className="space-y-6">
      <Card className="min-w-0 overflow-hidden">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-primary" />
                Manage accounts
              </CardTitle>
              <CardDescription>
                {pagination?.total ?? 0}{" "}
                {pagination?.total === 1 ? "account" : "accounts"} total
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> New account
              </Button>
              <Select
                value={roleFilter}
                onValueChange={(v) => {
                  setRoleFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All roles</SelectItem>
                  <SelectItem value="ADMIN">Administrator</SelectItem>
                  <SelectItem value="ORGANIZER">Organizer</SelectItem>
                  <SelectItem value="USER">Student</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={statusFilter}
                onValueChange={(v) => {
                  setStatusFilter(v);
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All status</SelectItem>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="SUSPENDED">Suspended</SelectItem>
                  <SelectItem value="PENDING_VERIFICATION">Pending</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="created-desc">Newest first</SelectItem>
                  <SelectItem value="created-asc">Oldest first</SelectItem>
                  <SelectItem value="name-asc">Name A-Z</SelectItem>
                  <SelectItem value="name-desc">Name Z-A</SelectItem>
                  <SelectItem value="lastlogin-desc">Recent login</SelectItem>
                </SelectContent>
              </Select>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search…"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setPage(1);
                  }}
                  className="pl-8 w-48"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isError && (
            <div className="px-6 pb-4">
              <p className="text-sm text-destructive">
                Couldn't load accounts. Please try again.
              </p>
            </div>
          )}
          <div className="max-h-[32rem] overflow-y-auto ng-scroll">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Program
                  </TableHead>
                  <TableHead className="hidden md:table-cell">
                    Student ID
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">
                    Last login
                  </TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-sm text-muted-foreground py-8"
                    >
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && accounts.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-sm text-muted-foreground py-8"
                    >
                      No accounts found.
                    </TableCell>
                  </TableRow>
                )}
                {accounts.map((a, idx) => (
                  <motion.tr
                    key={a.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: 0.18,
                      delay: Math.min(idx * 0.015, 0.15),
                    }}
                    className="hover:bg-muted/40"
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <DiceBearAvatar fullName={a.fullName} size={28} />
                        <div className="flex flex-col">
                          <span className="font-medium">{a.fullName}</span>
                          {a.organizationName && (
                            <Badge
                              variant="outline"
                              className="mt-0.5 w-fit gap-1 text-[10px] border-amber-500/40 text-amber-600"
                            >
                              <ShieldCheck className="h-3 w-3" />
                              {a.organizationName}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                      {a.email}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          a.role === "ADMIN"
                            ? "border-primary/40 text-primary"
                            : a.role === "ORGANIZER"
                              ? "border-amber-500/40 text-amber-600"
                              : "border-muted text-muted-foreground"
                        }
                      >
                        {ROLE_LABELS[a.role]}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          a.status === "ACTIVE"
                            ? "border-emerald-500/40 text-emerald-600"
                            : a.status === "SUSPENDED"
                              ? "border-red-500/40 text-red-600"
                              : "border-amber-500/40 text-amber-600"
                        }
                      >
                        {STATUS_LABELS[a.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {a.program ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Badge
                              variant="outline"
                              className="cursor-help text-[11px]"
                            >
                              {a.program}
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>
                            {getProgramLabel(a.program) ?? a.program}
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell font-mono text-xs tabular-nums">
                      {a.studentId != null ? a.studentId : "—"}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                      {a.lastLoginAt
                        ? format(new Date(a.lastLoginAt), "MMM d, HH:mm")
                        : "Never"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-primary"
                              onClick={() => openEdit(a)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Edit details</TooltipContent>
                        </Tooltip>
                        {a.status === "ACTIVE" ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-amber-600 hover:text-amber-700"
                                onClick={() =>
                                  setPendingAction({
                                    account: a,
                                    value: "SUSPENDED",
                                  })
                                }
                              >
                                <Ban className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Suspend</TooltipContent>
                          </Tooltip>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                                onClick={() =>
                                  setPendingAction({
                                    account: a,
                                    value: "ACTIVE",
                                  })
                                }
                              >
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Reactivate</TooltipContent>
                          </Tooltip>
                        )}
                        {currentUser?.role === "ADMIN" && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                                onClick={() =>
                                  setDeleteTarget({ account: a, hard: true })
                                }
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Delete permanently</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                  </motion.tr>
                ))}
              </TableBody>
            </Table>
          </div>

          {pagination && (
            <div className="flex items-center justify-between px-4 py-3 border-t gap-2 flex-wrap">
              <p className="text-xs text-muted-foreground">
                Page {pagination.page} of {pagination.totalPages} ·{" "}
                {pagination.total} accounts total
              </p>
              <div className="flex gap-2 items-center">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="h-4 w-4" /> Prev
                </Button>
                <span
                  className="text-xs font-medium tabular-nums min-w-[2rem] text-center"
                  aria-label={`Page ${pagination.page} of ${pagination.totalPages}`}
                >
                  {pagination.page}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create account dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setCreateErrors({});
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="h-5 w-5 text-primary" /> Create account
            </DialogTitle>
            <DialogDescription>
              Create an administrator or organizer account. Students register
              themselves.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="newFullName">Full name</Label>
              <Input
                id="newFullName"
                placeholder="Jane Smith"
                value={newFullName}
                onChange={(e) => setNewFullName(e.target.value)}
              />
              {createErrors.fullName && (
                <p className="text-xs text-destructive">
                  {createErrors.fullName}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newEmail">Email</Label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="newEmail"
                  type="email"
                  placeholder="name@ctu.edu.ph"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="pl-9"
                />
              </div>
              {createErrors.email && (
                <p className="text-xs text-destructive">{createErrors.email}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newPassword">Password</Label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  id="newPassword"
                  type="password"
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="pl-9"
                />
              </div>
              {createErrors.password && (
                <p className="text-xs text-destructive">
                  {createErrors.password}
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Min 8 chars, 1 uppercase, 1 lowercase, 1 number, 1 special
                character.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select
                value={newRole}
                onValueChange={(v) => setNewRole(v as "ADMIN" | "ORGANIZER")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ORGANIZER">Organizer (teacher)</SelectItem>
                  <SelectItem value="ADMIN">Administrator</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {newRole === "ORGANIZER" && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="newProgram">Program (optional)</Label>
                    <Select
                      value={newProgram || "__none__"}
                      onValueChange={(v) =>
                        setNewProgram(v === "__none__" ? "" : v)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select program" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">None</SelectItem>
                        {PROGRAMS.map((p) => (
                          <SelectItem key={p.code} value={p.code}>
                            {p.code} — {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="newSection">Section (optional)</Label>
                    <Input
                      id="newSection"
                      placeholder="2-B"
                      value={newSection}
                      onChange={(e) => setNewSection(e.target.value)}
                    />
                    {createErrors.section && (
                      <p className="text-xs text-destructive">
                        {createErrors.section}
                      </p>
                    )}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="newOrgName">
                    Organization name (optional)
                  </Label>
                  <Input
                    id="newOrgName"
                    placeholder="e.g. College of Technology"
                    value={newOrgName}
                    onChange={(e) => setNewOrgName(e.target.value)}
                  />
                </div>
              </>
            )}
            <p className="text-[11px] text-muted-foreground">
              The account is created as Active — no email verification needed.
            </p>
            <Button
              type="submit"
              className="w-full"
              disabled={createMut.isPending}
            >
              {createMut.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              Create account
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      {/* Suspend/Reactivate dialog */}
      <ConfirmDialog
        open={!!pendingAction}
        onOpenChange={(o) => !o && setPendingAction(null)}
        destructive={pendingAction?.value === "SUSPENDED"}
        title={
          pendingAction?.value === "SUSPENDED"
            ? "Suspend this account?"
            : "Reactivate this account?"
        }
        description={
          pendingAction?.value === "SUSPENDED"
            ? `${pendingAction?.account?.fullName ?? ""} will be signed out immediately and won't be able to sign in until reactivated.`
            : `${pendingAction?.account?.fullName ?? ""} will be able to sign in again.`
        }
        confirmLabel={
          pendingAction?.value === "SUSPENDED"
            ? "Suspend account"
            : "Reactivate account"
        }
        confirmText={
          pendingAction?.value === "SUSPENDED" ? "SUSPEND" : "ACTIVATE"
        }
        step2Warning={
          pendingAction?.value === "SUSPENDED"
            ? "The user will be signed out immediately and cannot sign in until reactivated."
            : "This account will be able to sign in again."
        }
        onConfirm={confirmAction}
      />

      {/* Delete account dialog */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        destructive={true}
        title="Delete this account?"
        description={`This will permanently delete ${deleteTarget?.account?.fullName ?? ""} and ALL related data (attendance, overrides, sessions). This cannot be undone.`}
        confirmLabel="Delete permanently"
        confirmText="DELETE"
        step2Warning="All attendance records will be permanently lost."
        onConfirm={confirmDelete}
      />

      {/* Edit account dialog */}
      <Dialog
        open={!!editTarget}
        onOpenChange={(o) => !o && setEditTarget(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="h-5 w-5 text-primary" /> Edit account
            </DialogTitle>
            <DialogDescription>
              Update {editTarget?.account?.fullName ?? ""}'s details. Changes
              are saved immediately.
            </DialogDescription>
          </DialogHeader>
          {editTarget && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="editFullName">Full name</Label>
                <Input
                  id="editFullName"
                  value={editTarget.fullName}
                  onChange={(e) =>
                    setEditTarget({ ...editTarget, fullName: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="editEmail">Email</Label>
                <Input
                  id="editEmail"
                  type="email"
                  value={editTarget.email}
                  onChange={(e) =>
                    setEditTarget({ ...editTarget, email: e.target.value })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label>Role</Label>
                  <Select
                    value={editTarget.role}
                    onValueChange={(v) =>
                      setEditTarget({
                        ...editTarget,
                        role: v as Account["role"],
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USER">Student</SelectItem>
                      <SelectItem value="ORGANIZER">Organizer</SelectItem>
                      <SelectItem value="ADMIN">Administrator</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <Select
                    value={editTarget.status}
                    onValueChange={(v) =>
                      setEditTarget({
                        ...editTarget,
                        status: v as Account["status"],
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ACTIVE">Active</SelectItem>
                      <SelectItem value="SUSPENDED">Suspended</SelectItem>
                      <SelectItem value="PENDING_VERIFICATION">
                        Pending
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Program</Label>
                <Select
                  value={editTarget.program}
                  onValueChange={(v) =>
                    setEditTarget({ ...editTarget, program: v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— Not specified —</SelectItem>
                    {PROGRAMS.map((p) => (
                      <SelectItem key={p.code} value={p.code}>
                        {p.code} — {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="editSection">Section</Label>
                  <Input
                    id="editSection"
                    value={editTarget.section}
                    onChange={(e) =>
                      setEditTarget({ ...editTarget, section: e.target.value })
                    }
                    placeholder="e.g. 2-B"
                  />
                </div>
                {editTarget.role === "USER" && (
                  <div className="space-y-1.5">
                    <Label>Year level</Label>
                    <Select
                      value={String(editTarget.year)}
                      onValueChange={(v) =>
                        setEditTarget({ ...editTarget, year: Number(v) })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4, 5, 6].map((y) => (
                          <SelectItem key={y} value={String(y)}>
                            Year {y}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
              {editTarget.role === "ORGANIZER" && (
                <div className="space-y-1.5">
                  <Label htmlFor="editOrgName">Organization name</Label>
                  <Input
                    id="editOrgName"
                    value={editTarget.organizationName}
                    onChange={(e) =>
                      setEditTarget({
                        ...editTarget,
                        organizationName: e.target.value,
                      })
                    }
                    placeholder="e.g. College of Technology"
                  />
                </div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setEditTarget(null)}>
                  Cancel
                </Button>
                <Button onClick={saveEdit} disabled={updateMut.isPending}>
                  {updateMut.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  Save changes
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
