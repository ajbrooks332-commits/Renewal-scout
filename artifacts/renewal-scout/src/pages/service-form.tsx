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

const SERVICE_TYPES = [
  "Broadband", "Electricity", "Gas and electricity", "Car insurance", 
  "Home insurance", "Life insurance", "Credit card", "Loan", "Mobile phone", "Other"
];

const formSchema = z.object({
  serviceType: z.string().min(1, "Service type is required"),
  provider: z.string().min(1, "Provider is required").max(160),
  productName: z.string().nullable().optional(),
  monthlyCostGbp: z.coerce.number().nullable().optional(),
  annualCostGbp: z.coerce.number().nullable().optional(),
  renewalDate: z.string().nullable().optional(),
  contractEndDate: z.string().nullable().optional(),
  noticeDays: z.coerce.number().min(0).max(365).default(30),
  researchWindowDays: z.coerce.number().min(1).max(365).default(60),
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
    query: { enabled: !!id }
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
                        {SERVICE_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
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
                    <FormControl><Input type="number" step="0.01" {...field} value={field.value ?? ""} /></FormControl>
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
                    <FormControl><Input type="number" step="0.01" {...field} value={field.value ?? ""} /></FormControl>
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
