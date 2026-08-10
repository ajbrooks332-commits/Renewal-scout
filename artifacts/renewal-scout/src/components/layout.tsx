import { useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useGetMe, useLogout } from "@workspace/api-client-react";
import { Shield, ShieldAlert, LayoutDashboard, Plus, LogOut, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { data: auth, isLoading } = useGetMe();
  const [_, setLocation] = useLocation();
  const logout = useLogout();

  useEffect(() => {
    if (!isLoading && !auth?.authenticated) {
      setLocation("/login");
    }
  }, [isLoading, auth?.authenticated, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!auth?.authenticated) {
    return null;
  }

  return (
    <div className="min-h-[100dvh] flex flex-col md:flex-row bg-background">
      {/* Sidebar */}
      <aside className="w-full md:w-64 border-r border-border bg-sidebar md:h-[100dvh] md:sticky md:top-0 flex flex-col">
        <div className="p-6 flex items-center gap-3 border-b border-border">
          <div className="h-8 w-8 bg-primary rounded-md flex items-center justify-center text-primary-foreground">
            <Shield className="h-4 w-4" />
          </div>
          <span className="font-semibold tracking-tight text-sidebar-foreground">Renewal Scout</span>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <Link href="/" className="flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors">
            <LayoutDashboard className="h-4 w-4" />
            Dashboard
          </Link>
          <Link href="/services/new" className="flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-md text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground transition-colors">
            <Plus className="h-4 w-4" />
            Add Service
          </Link>
        </nav>

        <div className="p-4 border-t border-border">
          <Button 
            variant="ghost" 
            className="w-full justify-start text-sidebar-foreground" 
            onClick={() => logout.mutate(undefined, { onSuccess: () => setLocation("/login") })}
          >
            <LogOut className="mr-2 h-4 w-4" />
            Log Out
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0">
        {auth.setupWarnings && auth.setupWarnings.length > 0 && (
          <div className="bg-amber-50 dark:bg-amber-950/50 border-b border-amber-200 dark:border-amber-900 p-4">
            <div className="flex items-start gap-3 max-w-5xl mx-auto">
              <ShieldAlert className="h-5 w-5 text-amber-600 dark:text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1">
                <h3 className="text-sm font-medium text-amber-800 dark:text-amber-400">Setup Warnings</h3>
                <ul className="mt-1 space-y-1">
                  {auth.setupWarnings.map((w, i) => (
                    <li key={i} className="text-sm text-amber-700 dark:text-amber-300">{w}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
        <div className="flex-1 p-6 md:p-8 max-w-5xl w-full mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
