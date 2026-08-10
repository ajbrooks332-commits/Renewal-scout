import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

import LoginPage from '@/pages/login';
import DashboardPage from '@/pages/dashboard';
import ServiceDetailPage from '@/pages/service-detail';
import ServiceFormPage from '@/pages/service-form';
import HouseholdPage from '@/pages/household';

const queryClient = new QueryClient();

function Router() {
  return (
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/login" component={LoginPage} />
        <Route path="/" component={DashboardPage} />
        <Route path="/household" component={HouseholdPage} />
        <Route path="/services/new" component={ServiceFormPage} />
        <Route path="/services/:id" component={ServiceDetailPage} />
        <Route path="/services/:id/edit" component={ServiceFormPage} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
