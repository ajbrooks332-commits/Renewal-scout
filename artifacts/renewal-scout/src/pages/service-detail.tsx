import { useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetService, useTriggerResearch, useArchiveService, getGetServiceQueryKey } from "@workspace/api-client-react";
import type { CompletenessReport, MissingField } from "@workspace/api-client-react";
import { formatGbp, formatDate, formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AppLayout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ChevronLeft, Pencil, Archive, Search, ExternalLink, ShieldCheck,
  AlertTriangle, CheckSquare, Info, FileText, ChevronDown, Clock,
  Settings, CreditCard, XCircle, Loader2
} from "lucide-react";
import { useState, useEffect } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ServiceRequirementsTab } from "@/pages/service-requirements-tab";
import { CurrentDealTab } from "@/pages/current-deal-tab";

// ─── Completeness gate component ──────────────────────────────────────────────

function CompletenessGate({
  report,
  onGenericResearch,
  onFixHousehold,
  onFixRequirements,
  onFixDeal,
}: {
  report: CompletenessReport;
  onGenericResearch: () => void;
  onFixHousehold: () => void;
  onFixRequirements: () => void;
  onFixDeal: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const hasHouseholdGap  = report.required.some(f => f.destination === "household") || report.recommended.some(f => f.destination === "household");
  const hasRequirGap     = report.required.some(f => f.destination === "requirements") || report.recommended.some(f => f.destination === "requirements");
  const hasDealGap       = report.required.some(f => f.destination === "current-deal") || report.recommended.some(f => f.destination === "current-deal");

  if (report.blocking) {
    return (
      <div className="bg-destructive/10 border border-destructive/30 rounded-md p-4 space-y-3">
        <div className="flex items-start gap-3">
          <XCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="font-medium text-destructive">Required information missing</h4>
            <p className="text-sm text-destructive/80 mt-1">
              The following fields are needed for personalised research.
            </p>
            <ul className="mt-2 space-y-1">
              {report.required.map((item) => (
                <li key={item.label} className="text-sm text-destructive/80 flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-destructive shrink-0" />
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {hasHouseholdGap  && <Button size="sm" variant="outline" onClick={onFixHousehold}>Fill in household profile</Button>}
          {hasRequirGap     && <Button size="sm" variant="outline" onClick={onFixRequirements}>Fill in requirements</Button>}
          {hasDealGap       && <Button size="sm" variant="outline" onClick={onFixDeal}>Confirm current deal</Button>}
          <Button
            size="sm" variant="ghost"
            className="text-muted-foreground"
            title="Proceed without personalisation — results will be generic public examples"
            onClick={onGenericResearch}
          >
            Run generic research
          </Button>
        </div>
      </div>
    );
  }

  if (report.recommended.length > 0) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-md p-4 space-y-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="font-medium text-amber-800">Recommended fields missing</h4>
            <p className="text-sm text-amber-700 mt-1">
              Adding these will improve accuracy, but you can proceed without them.
            </p>
            <ul className="mt-2 space-y-1">
              {report.recommended.map((item) => (
                <li key={item.label} className="text-sm text-amber-700 flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />
                  {item.label}
                </li>
              ))}
            </ul>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="text-amber-500 hover:text-amber-700 shrink-0"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {hasHouseholdGap  && <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100" onClick={onFixHousehold}>Household profile</Button>}
          {hasRequirGap     && <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100" onClick={onFixRequirements}>Requirements</Button>}
          {hasDealGap       && <Button size="sm" variant="outline" className="border-amber-300 text-amber-800 hover:bg-amber-100" onClick={onFixDeal}>Current deal</Button>}
        </div>
      </div>
    );
  }

  return null;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ServiceDetailPage() {
  const params = useParams();
  const id = Number(params.id);
  const [_, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [genericMode, setGenericMode] = useState(false);
  const [activeTab, setActiveTab] = useState("overview");

  const { data: detail, isLoading } = useGetService(id);
  const triggerResearch = useTriggerResearch();
  const archiveService = useArchiveService();

  // Computed before any conditional return so the value is always stable
  // across renders (detail may be undefined while loading).
  const isResearching =
    detail?.runs?.some(
      (run) => run.status === "queued" || run.status === "running",
    ) ?? false;

  // Poll every 5 s while a research run is queued or running.
  // MUST be above all early returns to satisfy React's Rules of Hooks.
  // Stops automatically when the run completes, so idle pages do not poll.
  useEffect(() => {
    if (!isResearching) return;
    const timer = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: getGetServiceQueryKey(id) });
    }, 5000);
    return () => clearInterval(timer);
  }, [isResearching, id, queryClient]);

  if (isLoading) {
    return (
      <AppLayout>
        <div className="flex items-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading…
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
  // CompletenessReport is now imported from api-client-react — no cast needed.
  const completenessReport: CompletenessReport | undefined = detail.completenessReport;

  const handleResearch = (mode?: "personalised" | "generic") => {
    const resolvedMode = mode ?? (genericMode ? "generic" : "personalised");
    const body = { researchMode: resolvedMode };
    triggerResearch.mutate({ id, data: body as Parameters<typeof triggerResearch.mutate>[0]["data"] }, {
      onSuccess: () => {
        toast({ title: "Research started", description: "Refresh in a few minutes to see updates." });
        queryClient.invalidateQueries({ queryKey: getGetServiceQueryKey(id) });
      },
      onError: (err) => {
        const data = err.data as { error?: string; completenessReport?: CompletenessReport } | undefined;
        if (err.status === 422 && data?.completenessReport) {
          toast({ title: "Missing required info", description: data.error, variant: "destructive" });
        } else {
          toast({ title: "Failed to start research", description: data?.error || "Unknown error", variant: "destructive" });
        }
      }
    });
  };

  const handleArchive = () => {
    if (confirm("Are you sure you want to archive this service? It will be hidden from your dashboard.")) {
      archiveService.mutate({ id }, {
        onSuccess: () => {
          toast({ title: "Service archived" });
          setLocation("/");
        }
      });
    }
  };

  const showGate = !genericMode && completenessReport && (completenessReport.blocking || completenessReport.recommended.length > 0);

  return (
    <AppLayout>
      {/* Header row */}
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
          <Button variant="outline" size="sm" onClick={handleArchive} className="gap-2 text-muted-foreground hover:text-foreground">
            <Archive className="h-4 w-4" />
            Archive
          </Button>
        </div>
      </div>

      {/* Title + research button */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">{service.serviceType}</h1>
          <p className="text-lg text-muted-foreground mt-1 flex items-center gap-2">
            {service.provider}
            {service.productName && <span>&bull; {service.productName}</span>}
          </p>
        </div>
        <Button
          size="lg"
          onClick={() => handleResearch()}
          disabled={isResearching || triggerResearch.isPending}
          className="gap-2 shadow-sm"
        >
          {isResearching || triggerResearch.isPending ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> {isResearching ? "Research in progress…" : "Starting…"}</>
          ) : (
            <><Search className="h-4 w-4" /> Research current deals</>
          )}
        </Button>
      </div>

      {/* Completeness gate */}
      {showGate && (
        <div className="mb-6">
          <CompletenessGate
            report={completenessReport!}
            onGenericResearch={() => { setGenericMode(true); handleResearch("generic"); }}
            onFixHousehold={() => setLocation("/household")}
            onFixRequirements={() => setActiveTab("requirements")}
            onFixDeal={() => setActiveTab("deal")}
          />
        </div>
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-6">
          <TabsTrigger value="overview" className="gap-2">
            <ShieldCheck className="h-4 w-4" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="requirements" className="gap-2">
            <Settings className="h-4 w-4" />
            Requirements
          </TabsTrigger>
          <TabsTrigger value="deal" className="gap-2">
            <CreditCard className="h-4 w-4" />
            Current Deal
          </TabsTrigger>
        </TabsList>

        {/* ── Overview tab ── */}
        <TabsContent value="overview">
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

          {/* ── Latest comparison ── */}
          <div className="space-y-6 mb-12">
            <h2 className="text-2xl font-semibold tracking-tight">Latest Comparison</h2>

            {!latestReport ? (
              <Card className="border-dashed bg-muted/30">
                <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                  <Search className="h-10 w-10 text-muted-foreground mb-4 opacity-50" />
                  <h3 className="text-lg font-medium text-foreground">No comparison yet</h3>
                  <p className="text-muted-foreground mt-1 max-w-md">
                    Research this service to see current deals and potential savings.
                  </p>
                  <Button onClick={() => handleResearch()} variant="outline" className="mt-6" disabled={isResearching}>
                    {isResearching ? "Researching…" : "Start Research"}
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
                              Source <ExternalLink className="ml-1 h-3 w-3" />
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

                {/* Comparison based on — collapsible */}
                {latestReport.comparisonBasedOn && latestReport.comparisonBasedOn.length > 0 && (
                  <Collapsible open={comparisonOpen} onOpenChange={setComparisonOpen} className="border border-border rounded-md">
                    <CollapsibleTrigger className="flex items-center justify-between w-full p-4 font-medium hover:bg-muted/30 transition-colors">
                      <span className="flex items-center gap-2 text-sm">
                        <Info className="h-4 w-4 text-muted-foreground" />
                        Comparison based on
                      </span>
                      <ChevronDown className={`h-4 w-4 transition-transform ${comparisonOpen ? "rotate-180" : ""}`} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="p-4 pt-0 border-t border-border">
                      <ul className="space-y-1.5">
                        {latestReport.comparisonBasedOn.map((item, i) => (
                          <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                            <span className="text-primary mt-0.5">•</span>
                            {item}
                          </li>
                        ))}
                      </ul>
                      {service.serviceType === "Life insurance" && (
                        <p className="mt-3 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                          Life insurance: Always seek regulated financial advice before making changes.
                          Never cancel existing cover before replacement cover is confirmed active.
                        </p>
                      )}
                    </CollapsibleContent>
                  </Collapsible>
                )}

                <Collapsible open={sourcesOpen} onOpenChange={setSourcesOpen} className="border border-border rounded-md">
                  <CollapsibleTrigger className="flex items-center justify-between w-full p-4 font-medium hover:bg-muted/30 transition-colors">
                    <span className="text-sm">View all research sources</span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${sourcesOpen ? "rotate-180" : ""}`} />
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

          {/* Research audit trail */}
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
                        <Badge variant="outline" className={`capitalize ${run.status === "complete" ? "bg-emerald-50 text-emerald-700" : run.status === "failed" ? "bg-destructive/10 text-destructive" : ""}`}>
                          {run.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── Requirements tab ── */}
        <TabsContent value="requirements">
          <ServiceRequirementsTab serviceId={id} serviceType={service.serviceType} />
        </TabsContent>

        {/* ── Current deal tab ── */}
        <TabsContent value="deal">
          <CurrentDealTab serviceId={id} />
        </TabsContent>
      </Tabs>
    </AppLayout>
  );
}
