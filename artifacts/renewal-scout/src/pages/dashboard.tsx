import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { 
  useGetDashboardStats, 
  useListServices, 
  useListResearchRuns,
  useRunDueCheck,
  getListServicesQueryKey,
  getListResearchRunsQueryKey
} from "@workspace/api-client-react";
import { formatGbp, formatDate, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Activity, Clock, ShieldCheck, Wallet, ArrowRight, Play, Plus, ServerCrash } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { AppLayout } from "@/components/layout";

export default function DashboardPage() {
  const [_, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: stats } = useGetDashboardStats();
  const { data: services } = useListServices();
  const { data: runs } = useListResearchRuns();
  
  const runDueCheck = useRunDueCheck();

  const handleDueCheck = () => {
    runDueCheck.mutate(undefined, {
      onSuccess: (res) => {
        toast({
          title: "Due check complete",
          description: res.message,
        });
        queryClient.invalidateQueries({ queryKey: getListServicesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListResearchRunsQueryKey() });
      },
      onError: (err) => {
        toast({
          title: "Check failed",
          description: err.data?.error || "Could not run due check",
          variant: "destructive"
        });
      }
    });
  };

  const sortedServices = services ? [...services].sort((a, b) => {
    // Sort by days remaining ascending, nulls at end
    if (a.daysRemaining === null) return 1;
    if (b.daysRemaining === null) return -1;
    return a.daysRemaining - b.daysRemaining;
  }) : [];

  const getUrgencyChip = (days: number | null) => {
    if (days === null) return <Badge variant="secondary" className="font-normal text-muted-foreground bg-muted">No date</Badge>;
    if (days < 0) return <Badge variant="destructive" className="font-medium">Overdue</Badge>;
    if (days <= 30) return <Badge variant="default" className="bg-amber-500 hover:bg-amber-600 text-white font-medium">{days} days</Badge>;
    return <Badge variant="secondary" className="font-normal">{days} days</Badge>;
  };

  const getRunStatusColor = (status: string) => {
    switch(status) {
      case "queued": return "text-blue-500 bg-blue-50 dark:bg-blue-950 border-blue-200";
      case "running": return "text-blue-600 bg-blue-100 dark:bg-blue-900 border-blue-300 animate-pulse";
      case "complete": return "text-emerald-600 bg-emerald-50 dark:bg-emerald-950 border-emerald-200";
      case "failed": return "text-destructive bg-destructive/10 border-destructive/20";
      default: return "text-muted-foreground bg-muted border-border";
    }
  };

  return (
    <AppLayout>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Overview of your household services and renewals</p>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            variant="outline" 
            onClick={handleDueCheck} 
            disabled={runDueCheck.isPending}
            className="gap-2"
          >
            <Play className="h-4 w-4" />
            {runDueCheck.isPending ? "Checking..." : "Run due check"}
          </Button>
          <Button onClick={() => setLocation("/services/new")} className="gap-2">
            <Plus className="h-4 w-4" />
            Add service
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tracked Services</CardTitle>
            <ShieldCheck className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalServices ?? "—"}</div>
          </CardContent>
        </Card>
        
        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Estimated Annual</CardTitle>
            <Wallet className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatGbp(stats?.totalAnnualCostGbp)}</div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Within 90 Days</CardTitle>
            <Clock className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-amber-600 dark:text-amber-500">{stats?.withinNinetyDays ?? "—"}</div>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Due Now</CardTitle>
            <Activity className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{stats?.dueNow ?? "—"}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">Active Services</h2>
          <Card className="shadow-sm overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Service</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Annual Cost</TableHead>
                  <TableHead>Renewal Date</TableHead>
                  <TableHead>Urgency</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedServices.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                      No services tracked yet. Click "Add service" to begin.
                    </TableCell>
                  </TableRow>
                ) : (
                  sortedServices.map((service) => (
                    <TableRow 
                      key={service.id} 
                      className="cursor-pointer hover:bg-muted/30 transition-colors group"
                      onClick={() => setLocation(`/services/${service.id}`)}
                    >
                      <TableCell className="font-medium">{service.serviceType}</TableCell>
                      <TableCell>{service.provider}</TableCell>
                      <TableCell>{formatGbp(service.annualCostGbp)}</TableCell>
                      <TableCell>{formatDate(service.renewalDate)}</TableCell>
                      <TableCell>{getUrgencyChip(service.daysRemaining)}</TableCell>
                      <TableCell>
                        <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>
        </div>

        <div className="space-y-4">
          <h2 className="text-xl font-semibold tracking-tight">Recent Research</h2>
          <Card className="shadow-sm">
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {(!runs || runs.length === 0) ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    No research runs yet.
                  </div>
                ) : (
                  runs.slice(0, 8).map(run => (
                    <div key={run.id} className="p-4 hover:bg-muted/30 transition-colors">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <Link href={`/services/${run.serviceId}`} className="font-medium hover:underline text-sm truncate block">
                            {run.serviceName}
                          </Link>
                          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                            <span>{formatDateTime(run.createdAt)}</span>
                            <span>&bull;</span>
                            <span className="capitalize">{run.trigger}</span>
                          </div>
                        </div>
                        <Badge variant="outline" className={`capitalize text-xs font-medium ${getRunStatusColor(run.status)}`}>
                          {run.status}
                        </Badge>
                      </div>
                      {run.error && (
                        <div className="mt-2 text-xs text-destructive flex items-start gap-1 bg-destructive/5 p-2 rounded border border-destructive/10">
                          <ServerCrash className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="break-words">{run.error}</span>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
