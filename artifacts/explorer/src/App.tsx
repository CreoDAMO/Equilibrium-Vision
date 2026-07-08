import React from "react";
import { ErrorBoundary, withErrorBoundary } from "@/components/ErrorBoundary";
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
import StakingPage from "@/pages/Staking";
import DexPage from "@/pages/Dex";
import SearchPage from "@/pages/Search";
import ModelsPage from "@/pages/Models";
import ArbitragePage from "@/pages/Arbitrage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const base = import.meta.env.BASE_URL.replace(/\/$/, "");

// Each page component is wrapped so a crash in one route shows an inline
// fallback while the nav bar (and every other route) stays fully functional.
const SafeDashboard      = withErrorBoundary(Dashboard);
const SafeBlocks         = withErrorBoundary(Blocks);
const SafeBlockDetail    = withErrorBoundary(BlockDetail);
const SafeTxDetail       = withErrorBoundary(TxDetail);
const SafeAddressDetail  = withErrorBoundary(AddressDetail);
const SafeMempool        = withErrorBoundary(MempoolPage);
const SafeNetwork        = withErrorBoundary(NetworkPage);
const SafeValidators     = withErrorBoundary(Validators);
const SafeValidatorDetail = withErrorBoundary(ValidatorDetail);
const SafeGovernance     = withErrorBoundary(GovernancePage);
const SafeFaucet         = withErrorBoundary(FaucetPage);
const SafeWalletHome     = withErrorBoundary(WalletHome);
const SafeWalletCreate   = withErrorBoundary(WalletCreate);
const SafeWalletImport   = withErrorBoundary(WalletImport);
const SafeWalletSend     = withErrorBoundary(WalletSend);
const SafeWalletMultisig = withErrorBoundary(WalletMultisig);
const SafeSearch         = withErrorBoundary(SearchPage);
const SafeStaking        = withErrorBoundary(StakingPage);
const SafeDex            = withErrorBoundary(DexPage);
const SafeContracts      = withErrorBoundary(ContractsPage);
const SafeContractDetail = withErrorBoundary(ContractDetail);
const SafeAdminMultisig  = withErrorBoundary(AdminMultisig);
const SafeModels         = withErrorBoundary(ModelsPage);
const SafeArbitrage      = withErrorBoundary(ArbitragePage);

function AppRouter() {
  useChainWebSocket();

  return (
    <Router base={base}>
      <Layout>
        <Switch>
          <Route path="/"                    component={SafeDashboard} />
          <Route path="/blocks"              component={SafeBlocks} />
          <Route path="/blocks/:hashOrHeight" component={SafeBlockDetail} />
          <Route path="/tx/:hash"            component={SafeTxDetail} />
          <Route path="/address/:addr"       component={SafeAddressDetail} />
          <Route path="/mempool"             component={SafeMempool} />
          <Route path="/network"             component={SafeNetwork} />
          <Route path="/validators"          component={SafeValidators} />
          <Route path="/validators/:addr"    component={SafeValidatorDetail} />
          <Route path="/governance"          component={SafeGovernance} />
          <Route path="/faucet"              component={SafeFaucet} />
          <Route path="/wallet"              component={SafeWalletHome} />
          <Route path="/wallet/create"       component={SafeWalletCreate} />
          <Route path="/wallet/import"       component={SafeWalletImport} />
          <Route path="/wallet/send"         component={SafeWalletSend} />
          <Route path="/wallet/multisig"     component={SafeWalletMultisig} />
          <Route path="/search/:query"       component={SafeSearch} />
          <Route path="/staking"             component={SafeStaking} />
          <Route path="/dex"                 component={SafeDex} />
          <Route path="/contracts"           component={SafeContracts} />
          <Route path="/contracts/:address"  component={SafeContractDetail} />
          <Route path="/admin/multisig"      component={SafeAdminMultisig} />
          <Route path="/models"              component={SafeModels} />
          <Route path="/arbitrage"           component={SafeArbitrage} />
          <Route component={NotFound} />
        </Switch>
      </Layout>
    </Router>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WalletProvider>
            <AppRouter />
          </WalletProvider>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

export default App;
