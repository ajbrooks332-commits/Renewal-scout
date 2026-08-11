import { useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetService, 
  useCreateService, 
  useUpdateService,
  getListServicesQueryKey,
  getGetServiceQueryKey
} from "@workspace/api-client-react";

import { AppLayout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ChevronLeft, Info, Loader2, Save } from "lucide-react";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { SERVICE_TYPES } from "@workspace/api-zod";

// Single source of truth for service type values — imported from api-zod.
// This ensures client-side and server-side enum lists are always identical.
const SERVICE_TYPE_LIST: readonly string[] = SERVICE_TYPES;

// Reusable calendar-date refine — validates YYYY-MM-DD and rejects impossible
// dates (e.g. 2026-02-30) without needing z.preprocess (which breaks TypeScript
// inference in z.object schemas).
function isValidCalendarDate(v: string | null | undefined): boolean {
  if (!v) return true; // null/empty is allowed at this layer
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [year, month, day] = v.split("-").map(Number);
  const d = new Date(year!, month! - 1, day!);
  return (
    d.getFullYear() === year &&
    d.getMonth() === month! - 1 &&
    d.getDate() === day
  );
}

// Form schema: mirrors StrictCreateServiceBody constraints but keeps types simple
// so react-hook-form can infer and manage them without TypeScript struggling.
// HTML <input type="number"> returns empty string when blank, so we use
// z.coerce.number() which handles the string→number conversion cleanly.
const formSchema = z.object({
  // Validate against the shared SERVICE_TYPES list (same constraint as the server).
  // Using .refine() rather than z.enum() keeps the TypeScript output type as
  // `string`, which avoids a conflict with react-hook-form's FieldValues generic.
  serviceType: z
    .string()
    .min(1, "Please select a service type")
    .refine(
      (v) => (SERVICE_TYPES as readonly string[]).includes(v),
      "Please select a valid service type",
    ),
  provider: z.string().min(1, "Provider is required").max(160),
  productName: z.string().nullable().optional(),
  // Costs: react-hook-form stores null (not 0) for blank inputs — see onChange
  // handler on the cost <Input> elements below. Without coerce, null passes
  // through and the schema cleanly distinguishes blank (null) from £0 (0).
  monthlyCostGbp: z.number().min(0, "Must be non-negative").nullable().optional(),
  annualCostGbp: z.number().min(0, "Must be non-negative").nullable().optional(),
  // Dates: validate as real calendar dates (server also validates, but good UX)
  renewalDate: z.string().nullable().optional()
    .refine(isValidCalendarDate, "Must be a valid date (YYYY-MM-DD)"),
  contractEndDate: z.string().nullable().optional()
    .refine(isValidCalendarDate, "Must be a valid date (YYYY-MM-DD)"),
  // Notice/window days: coerce from string, validate as non-negative integers
  noticeDays: z.coerce.number().int().min(0).max(365).default(30),
  researchWindowDays: z.coerce.number().int().min(1).max(365).default(60),
  location: z.string().nullable().optional(),
  currentTerms: z.string().nullable().optional(),
  preferences: z.string().nullable().optional(),
  quoteFacts: z.string().nullable().optional(),
  autoResearch: z.boolean().default(false),
});

type FormValues = z.infer<typeof formSchema>;

export default function ServiceFormPage() {
  const params = useParams();
  const isNew = !params.id || params.id === "new";
  const id = isNew ? null : Number(params.id);
  
  const [_, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: detail, isLoading: isFetching } = useGetService(id!, {
    query: { enabled: !!id, queryKey: getGetServiceQueryKey(id!) }
  });

  const createService = useCreateService();
  const updateService = useUpdateService();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      serviceType: "",
      provider: "",
      productName: "",
      monthlyCostGbp: null,
      annualCostGbp: null,
      renewalDate: "",
      contractEndDate: "",
      noticeDays: 30,
      researchWindowDays: 60,
      location: "",
      currentTerms: "",
      preferences: "",
      quoteFacts: "",
      autoResearch: false
    }
  });

  useEffect(() => {
    if (detail?.service && !isNew) {
      const s = detail.service;
      form.reset({
        serviceType: s.serviceType,
        provider: s.provider,
        productName: s.productName || "",
        monthlyCostGbp: s.monthlyCostGbp,
        annualCostGbp: s.annualCostGbp,
        renewalDate: s.renewalDate ? s.renewalDate.split('T')[0] : "",
        contractEndDate: s.contractEndDate ? s.contractEndDate.split('T')[0] : "",
        noticeDays: s.noticeDays,
        researchWindowDays: s.researchWindowDays,
        location: s.location || "",
        currentTerms: s.currentTerms || "",
        preferences: s.preferences || "",
        quoteFacts: s.quoteFacts || "",
        autoResearch: s.autoResearch,
      });
    }
  }, [detail, isNew, form]);

  const onSubmit = (values: FormValues) => {
    // Transform empty strings to null for optional API fields
    const payload = {
      ...values,
      productName: values.productName || null,
      renewalDate: values.renewalDate || null,
      contractEndDate: values.contractEndDate || null,
      location: values.location || null,
      currentTerms: values.currentTerms || null,
      preferences: values.preferences || null,
      quoteFacts: values.quoteFacts || null,
    };

    if (isNew) {
      createService.mutate({ data: payload }, {
        onSuccess: (res) => {
          toast({ title: "Service created" });
          queryClient.invalidateQueries({ queryKey: getListServicesQueryKey() });
          setLocation(`/services/${res.id}`);
        },
        onError: (err) => {
          toast({ title: "Failed to create", description: err.data?.error, variant: "destructive" });
        }
      });
    } else {
      updateService.mutate({ id: id!, data: payload }, {
        onSuccess: () => {
          toast({ title: "Service updated" });
          queryClient.invalidateQueries({ queryKey: getListServicesQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetServiceQueryKey(id!) });
          setLocation(`/services/${id}`);
        },
        onError: (err) => {
          toast({ title: "Failed to update", description: err.data?.error, variant: "destructive" });
        }
      });
    }
  };

  if (!isNew && isFetching) {
    return (
      <AppLayout>
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      </AppLayout>
    );
  }

  const isPending = createService.isPending || updateService.isPending;

  return (
    <AppLayout>
      <div className="mb-6">
        <Button variant="ghost" size="sm" onClick={() => setLocation(isNew ? "/" : `/services/${id}`)} className="gap-2 -ml-3 text-muted-foreground hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
          Back
        </Button>
      </div>
      
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">{isNew ? "Add Service" : "Edit Service"}</h1>
        <p className="text-muted-foreground mt-1">Track details and research preferences for this household service.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8 max-w-4xl pb-16">
          <Card className="shadow-sm">
            <CardHeader className="pb-4 border-b border-border/50">
              <CardTitle>Basic Information</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <FormField
                control={form.control}
                name="serviceType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Service Type</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value} value={field.value}>
                      <FormControl>
                        <SelectTrigger><SelectValue placeholder="Select type..." /></SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SERVICE_TYPE_LIST.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Provider</FormLabel>
                    <FormControl><Input placeholder="e.g. BT, Octopus Energy" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="productName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Product/Tariff Name (Optional)</FormLabel>
                    <FormControl><Input placeholder="e.g. Fibre 100" {...field} value={field.value || ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="hidden md:block"></div>

              <FormField
                control={form.control}
                name="monthlyCostGbp"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Monthly Cost (£)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) => {
                          // Store null (not 0) when the field is cleared so blank
                          // and explicit £0 are distinguishable downstream.
                          const v = e.target.value;
                          field.onChange(v === "" ? null : parseFloat(v));
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="annualCostGbp"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Annual Cost (£) <span className="text-muted-foreground font-normal ml-1">(Overrides monthly x 12)</span></FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        {...field}
                        value={field.value ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          field.onChange(v === "" ? null : parseFloat(v));
                        }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-4 border-b border-border/50">
              <CardTitle>Dates & Timing</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <FormField
                control={form.control}
                name="renewalDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Renewal Date</FormLabel>
                    <FormControl><Input type="date" {...field} value={field.value || ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="contractEndDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contract End Date</FormLabel>
                    <FormControl><Input type="date" {...field} value={field.value || ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="noticeDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notice Period (Days)</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="researchWindowDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start research N days before date</FormLabel>
                    <FormControl><Input type="number" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <Card className="shadow-sm">
            <CardHeader className="pb-4 border-b border-border/50">
              <CardTitle>Research Context</CardTitle>
            </CardHeader>
            <CardContent className="pt-6 space-y-6">
              <div className="bg-primary/5 border border-primary/10 rounded-md p-4 text-sm text-primary flex gap-3">
                <Info className="h-5 w-5 shrink-0" />
                <p>Use non-sensitive facts only. Do not enter passwords, full card details, bank details, or identity documents.</p>
              </div>

              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location / Postcode District</FormLabel>
                    <FormControl><Input placeholder="e.g. SW11 — avoid a full address" {...field} value={field.value || ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="currentTerms"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Terms</FormLabel>
                    <FormControl><Textarea className="min-h-[100px]" placeholder="What are you getting now? e.g. 100Mbps download, free evening calls" {...field} value={field.value || ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="preferences"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Preferences & Must-haves</FormLabel>
                    <FormControl><Textarea className="min-h-[100px]" placeholder="e.g. Must have 500+Mbps, prefer no setup fee, 12 month contract max" {...field} value={field.value || ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="quoteFacts"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Non-sensitive Quote Facts</FormLabel>
                    <FormControl><Textarea className="min-h-[100px]" placeholder="e.g. 3 bedroom semi-detached house built in 1950, no previous claims" {...field} value={field.value || ""} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              <FormField
                control={form.control}
                name="autoResearch"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 shadow-sm">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Auto-research</FormLabel>
                      <FormDescription>
                        Automatically queue a research run when the target date is within the research window.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setLocation(isNew ? "/" : `/services/${id}`)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending} className="gap-2">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {isNew ? "Create Service" : "Save Changes"}
            </Button>
          </div>
        </form>
      </Form>
    </AppLayout>
  );
}
