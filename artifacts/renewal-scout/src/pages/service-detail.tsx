import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetService, useTriggerResearch, useArchiveService, getGetServiceQueryKey } from "@workspace/api-client-react";
import { formatGbp, formatDate, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AppLayout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { 
  ChevronLeft, Pencil, Trash2, Search, ExternalLink, ShieldCheck, 
  AlertTriangle, CheckSquare, Info, FileText, ChevronDown, Clock 
} from "lucide-react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export default function ServiceDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const [_, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const { data: detail, isLoading } = useGetService(id);
  const triggerResearch = useTriggerResearch();
  const archiveService = useArchiveService();

  if (isLoading) {
    return (
      <AppLayout>
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-1/4"></div>
          <div className="h-32 bg-muted rounded"></div>
        </div>
      </AppLayout>
    );
  }

  if (!detail || !detail.service) {
    return (
      <AppLayout>
        <div className="text-center py-12">
          <h2 className="text-2xl font-bold">Service not found</h2>
          <Button variant="link" onClick={() => setLocation("/")} className="mt-4">Return to dashboard</Button>
        </div>
      </AppLayout>
    );
  }

  const { service, runs, latestReport } = detail;

  const handleResearch = () => {
    triggerResearch.mutate({ id }, {
      onSuccess: () => {
        toast({ title: "Research started", description: "Refresh in a few minutes to see updates." });
        queryClient.invalidateQueries({ queryKey: getGetServiceQueryKey(id) });
      },
      onError: (err) => {
        toast({ title: "Failed to start research", description: err.data?.error || "Unknown error", variant: "destructive" });
      }
    });
  };

  const handleArchive = () => {
    if (confirm("Are you sure you want to delete this service?")) {
      archiveService.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Service deleted" });
          setLocation("/");
        }
      });
    }
  };

  const isResearching = runs.some(r => r.status === "queued" || r.status === "running");

  return (
    <AppLayout>
      <div className="mb-6 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/")} className="gap-2 -ml-3 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setLocation(`/services/${id}/edit`)} className="gap-2">
            <Pencil className="h-4 w-4" />
            Edit
          </Button>
          <Button variant="outline" size="sm" onClick={handleArchive} className="gap-2 text-destructive hover:text-destructive hover:bg-destructive/5">
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{service.serviceType}</h1>
          <p className="text-lg text-muted-foreground mt-1 flex items-center gap-2">
            {service.provider}
            {service.productName && <span>&bull; {service.productName}</span>}
          </p>
        </div>
        <Button 
          size="lg" 
          onClick={handleResearch} 
          disabled={isResearching || triggerResearch.isPending}
          className="gap-2 shadow-sm"
        >
          {isResearching ? (
            <><Clock className="h-4 w-4 animate-spin" /> Research in progress...</>
          ) : (
            <><Search className="h-4 w-4" /> Research current deals</>
          )}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <Card className="md:col-span-2 shadow-sm">
          <CardHeader className="pb-3 border-b border-border/50">
            <CardTitle className="text-lg">Service Summary</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-6">
              <div>
                <dt className="text-sm font-medium text-muted-foreground mb-1">Annual Cost</dt>
                <dd className="text-lg font-semibold">{formatGbp(service.annualCostGbp)}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground mb-1">Monthly Cost</dt>
                <dd className="text-lg font-semibold">{formatGbp(service.monthlyCostGbp)}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground mb-1">Renewal Date</dt>
                <dd className="text-lg font-semibold">{formatDate(service.renewalDate)}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground mb-1">Contract End</dt>
                <dd className="text-base">{formatDate(service.contractEndDate)}</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground mb-1">Notice Period</dt>
                <dd className="text-base">{service.noticeDays} days</dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-muted-foreground mb-1">Auto Research</dt>
                <dd className="text-base">{service.autoResearch ? "Enabled" : "Disabled"}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card className="bg-primary/5 border-primary/10 shadow-sm">
          <CardHeader className="pb-3 border-b border-primary/10">
            <CardTitle className="text-lg flex items-center gap-2 text-primary">
              <ShieldCheck className="h-5 w-5" />
              The agent prepares; you decide.
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-4 text-sm text-primary/80 space-y-2">
            <ul className="list-disc pl-4 space-y-1">
              <li>Searches current public offers</li>
              <li>Compares costs, terms and exclusions</li>
              <li>Builds a quote/application checklist</li>
              <li>Stops before forms, credit searches or payment</li>
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Report Section */}
      <div className="space-y-6 mb-12">
        <h2 className="text-2xl font-semibold tracking-tight">Latest Comparison</h2>
        
        {!latestReport ? (
          <Card className="border-dashed bg-muted/30">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <Search className="h-10 w-10 text-muted-foreground mb-4 opacity-50" />
              <h3 className="text-lg font-medium text-foreground">No comparison yet</h3>
              <p className="text-muted-foreground mt-1 max-w-md">
                Research this service to see current deals and potential savings based on your requirements.
              </p>
              <Button onClick={handleResearch} variant="outline" className="mt-6" disabled={isResearching}>
                {isResearching ? "Researching..." : "Start Research"}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            {latestReport.currentDealAssessment && (
              <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded-lg p-4 flex gap-3">
                <Info className="h-5 w-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                <div>
                  <h4 className="font-medium text-blue-900 dark:text-blue-300">Assessment</h4>
                  <p className="text-sm text-blue-800 dark:text-blue-400 mt-1">{latestReport.currentDealAssessment}</p>
                </div>
              </div>
            )}
            
            <p className="text-sm text-muted-foreground italic">
              {latestReport.scopeStatement} (As of {formatDate(latestReport.asOfDate)})
            </p>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {latestReport.options.map((opt, i) => (
                <Card key={i} className="flex flex-col shadow-sm hover:shadow-md transition-shadow">
                  <CardHeader className="pb-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <CardTitle className="text-lg">{opt.provider}</CardTitle>
                        <CardDescription className="mt-1">{opt.productName}</CardDescription>
                      </div>
                      <Badge variant={i === 0 ? "default" : "secondary"}>{opt.priceStatus}</Badge>
                    </div>
                    <div className="mt-4 pt-4 border-t border-border">
                      <div className="text-2xl font-bold">{formatGbp(opt.annualCostGbp)}<span className="text-sm font-normal text-muted-foreground">/yr</span></div>
                      <div className="text-sm text-muted-foreground mt-1">{formatGbp(opt.monthlyCostGbp)}/mo &bull; {opt.contractLengthMonths}m contract</div>
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 text-sm space-y-4">
                    <div>
                      <span className="font-medium mb-2 block">Headline Terms</span>
                      <ul className="space-y-1">
                        {opt.headlineTerms.map((term, j) => (
                          <li key={j} className="flex items-start gap-2 text-muted-foreground">
                            <span className="text-primary mt-0.5">•</span>
                            <span>{term}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {opt.importantExclusions.length > 0 && (
                      <div className="bg-amber-50 dark:bg-amber-950/30 p-3 rounded-md border border-amber-100 dark:border-amber-900/50">
                        <span className="font-medium text-amber-800 dark:text-amber-500 mb-1 flex items-center gap-1.5">
                          <AlertTriangle className="h-3.5 w-3.5" /> Check carefully
                        </span>
                        <ul className="space-y-1 text-amber-700 dark:text-amber-400 text-xs">
                          {opt.importantExclusions.map((ex, j) => (
                            <li key={j} className="flex items-start gap-1.5">
                              <span className="mt-0.5">-</span>
                              <span>{ex}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </CardContent>
                  <CardFooter className="pt-4 border-t border-border/50 bg-muted/10">
                    <div className="w-full flex flex-wrap gap-2">
                      {opt.sourceUrls.map((url, j) => (
                        <a key={j} href={url} target="_blank" rel="noreferrer" className="inline-flex items-center text-xs font-medium text-primary hover:underline">
                          Provider / Source <ExternalLink className="ml-1 h-3 w-3" />
                        </a>
                      ))}
                    </div>
                  </CardFooter>
                </Card>
              ))}
            </div>

            <Card className="bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/50 shadow-sm">
              <CardContent className="p-5 flex gap-4">
                <CheckSquare className="h-6 w-6 text-emerald-600 dark:text-emerald-500 shrink-0" />
                <div>
                  <h3 className="font-semibold text-emerald-900 dark:text-emerald-400">Recommended Next Step</h3>
                  <p className="text-emerald-800 dark:text-emerald-300 mt-1">{latestReport.recommendedNextStep}</p>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {latestReport.missingInformation.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-medium flex items-center gap-2"><Info className="h-4 w-4 text-blue-500" /> Missing Info</h4>
                  <ul className="text-sm space-y-1.5 text-muted-foreground pl-6 list-disc">
                    {latestReport.missingInformation.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              )}
              {latestReport.comparisonChecklist.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-medium flex items-center gap-2"><CheckSquare className="h-4 w-4 text-emerald-500" /> Comparison Checklist</h4>
                  <ul className="text-sm space-y-1.5 text-muted-foreground pl-6 list-disc">
                    {latestReport.comparisonChecklist.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              )}
              {latestReport.applicationPack.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-medium flex items-center gap-2"><FileText className="h-4 w-4 text-purple-500" /> Application Pack</h4>
                  <ul className="text-sm space-y-1.5 text-muted-foreground pl-6 list-disc">
                    {latestReport.applicationPack.map((item, i) => <li key={i}>{item}</li>)}
                  </ul>
                </div>
              )}
            </div>

            {latestReport.warnings.length > 0 && (
              <div className="bg-destructive/10 border border-destructive/20 rounded-md p-4 space-y-2">
                <h4 className="font-medium text-destructive flex items-center gap-2"><AlertTriangle className="h-4 w-4" /> Warnings</h4>
                <ul className="text-sm space-y-1 text-destructive/80 pl-6 list-disc">
                  {latestReport.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            <Collapsible open={sourcesOpen} onOpenChange={setSourcesOpen} className="border border-border rounded-md">
              <CollapsibleTrigger className="flex items-center justify-between w-full p-4 font-medium hover:bg-muted/30 transition-colors">
                <span>View all research sources</span>
                <ChevronDown className={`h-4 w-4 transition-transform ${sourcesOpen ? 'rotate-180' : ''}`} />
              </CollapsibleTrigger>
              <CollapsibleContent className="p-4 pt-0 border-t border-border">
                <ul className="space-y-2">
                  {latestReport.sources.map((s, i) => (
                    <li key={i} className="text-sm break-all">
                      <a href={s} target="_blank" rel="noreferrer" className="text-primary hover:underline">{s}</a>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-medium">Research Audit Trail</h3>
        <Card className="shadow-sm">
          <CardContent className="p-0">
            {runs.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground text-center">No research runs logged.</div>
            ) : (
              <div className="divide-y divide-border">
                {runs.map(run => (
                  <div key={run.id} className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <div className="font-medium text-sm capitalize">{run.trigger} run</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{formatDateTime(run.createdAt)}</div>
                      {run.error && <div className="text-xs text-destructive mt-1">{run.error}</div>}
                    </div>
                    <Badge variant="outline" className={`capitalize ${run.status === 'complete' ? 'bg-emerald-50 text-emerald-700' : run.status === 'failed' ? 'bg-destructive/10 text-destructive' : ''}`}>
                      {run.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
