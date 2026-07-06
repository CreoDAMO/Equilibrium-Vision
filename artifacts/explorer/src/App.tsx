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
import Validators from "@/pages/Validators";
import ValidatorDetail from "@/pages/ValidatorDetail";
import GovernancePage from "@/pages/Governance";
import FaucetPage from "@/pages/Faucet";
import NotFound from "@/pages/not-found";
import { WalletProvider } from "@/wallet/context";
import { useChainWebSocket } from "@/hooks/useChainWebSocket";
import WalletHome from "@/pages/wallet/WalletHome";
import WalletCreate from "@/pages/wallet/WalletCreate";
import WalletImport from "@/pages/wallet/WalletImport";
import WalletSend from "@/pages/wallet/WalletSend";
import WalletMultisig from "@/pages/wallet/WalletMultisig";
import ContractsPage from "@/pages/Contracts";
import ContractDetail from "@/pages/ContractDetail";
import AdminMultisig from "@/pages/AdminMultisig";

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
  // Open a single WebSocket connection for the whole app; invalidates React
  // Query caches on new_block / mempool_update events so all pages update
  // instantly without waiting for the next poll interval.
  useChainWebSocket();

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
          <Route path="/validators" component={Validators} />
          <Route path="/validators/:addr" component={ValidatorDetail} />
          <Route path="/governance" component={GovernancePage} />
          <Route path="/faucet" component={FaucetPage} />
          <Route path="/wallet" component={WalletHome} />
          <Route path="/wallet/create" component={WalletCreate} />
          <Route path="/wallet/import" component={WalletImport} />
          <Route path="/wallet/send" component={WalletSend} />
          <Route path="/wallet/multisig" component={WalletMultisig} />
          <Route path="/contracts" component={ContractsPage} />
          <Route path="/contracts/:address" component={ContractDetail} />
          <Route path="/admin/multisig" component={AdminMultisig} />
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
        <WalletProvider>
          <AppRouter />
        </WalletProvider>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
