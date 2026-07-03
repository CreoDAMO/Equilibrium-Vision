import React from "react";
import { Switch, Route, Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Blocks from "@/pages/Blocks";
import BlockDetail from "@/pages/BlockDetail";
import TxDetail from "@/pages/TxDetail";
import AddressDetail from "@/pages/AddressDetail";
import MempoolPage from "@/pages/Mempool";
import NetworkPage from "@/pages/Network";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

function AppRouter() {
  return (
    <Router base={base}>
      <Layout>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/blocks" component={Blocks} />
          <Route path="/blocks/:hashOrHeight" component={BlockDetail} />
          <Route path="/tx/:hash" component={TxDetail} />
          <Route path="/address/:addr" component={AddressDetail} />
          <Route path="/mempool" component={MempoolPage} />
          <Route path="/network" component={NetworkPage} />
          <Route component={NotFound} />
        </Switch>
      </Layout>
    </Router>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppRouter />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
