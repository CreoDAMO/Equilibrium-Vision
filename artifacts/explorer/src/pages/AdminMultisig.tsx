import React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shield, Activity, Users, Server } from "lucide-react";
import ChainHealthTab from "./admin/ChainHealthTab";
import ValidatorsTab from "./admin/ValidatorsTab";
import NodeTab from "./admin/NodeTab";
import MultisigTab from "./admin/MultisigTab";

export default function AdminMultisig() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Shield className="w-6 h-6" /> Admin Panel
        </h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Chain health, validator management, node diagnostics, and the on-chain multisig slash workflow.
        </p>
      </div>

      <Tabs defaultValue="health">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="health" className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" /> Chain Health
          </TabsTrigger>
          <TabsTrigger value="validators" className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> Validators
          </TabsTrigger>
          <TabsTrigger value="node" className="flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5" /> Node
          </TabsTrigger>
          <TabsTrigger value="multisig" className="flex items-center gap-1.5">
            <Shield className="w-3.5 h-3.5" /> Multisig
          </TabsTrigger>
        </TabsList>

        <TabsContent value="health" className="mt-6"><ChainHealthTab /></TabsContent>
        <TabsContent value="validators" className="mt-6"><ValidatorsTab /></TabsContent>
        <TabsContent value="node" className="mt-6"><NodeTab /></TabsContent>
        <TabsContent value="multisig" className="mt-6"><MultisigTab /></TabsContent>
      </Tabs>
    </div>
  );
}
