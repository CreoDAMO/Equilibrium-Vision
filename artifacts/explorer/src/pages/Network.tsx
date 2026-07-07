import React from "react";
import { useGetNetworkPeers, getGetNetworkPeersQueryKey } from "@workspace/api-client-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Users, Wifi, Globe, Clock } from "lucide-react";

export default function NetworkPage() {
  const { data: peers, isLoading } = useGetNetworkPeers({ query: { queryKey: getGetNetworkPeersQueryKey(), refetchInterval: 10000 } });

  const connectedCount = peers?.filter(p => p.connected).length || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="bg-primary/10 text-primary p-2 rounded-lg">
          <Users className="w-6 h-6" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">Network Peers</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Peers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{peers ? peers.length : "..."}</div>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Connected</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">{connectedCount}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2 flex flex-row justify-between">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Latency</CardTitle>
            <Clock className="w-4 h-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {peers && peers.length > 0 
                ? `${Math.round(peers.reduce((acc, p) => acc + p.latencyMs, 0) / peers.length)}ms` 
                : "..."}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Peer ID</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Height</TableHead>
                <TableHead className="text-right">Latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [...Array(4)].map((_, i) => (
                  <TableRow key={i}>
                    {[...Array(5)].map((__, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-muted rounded animate-pulse" style={{ animationDelay: `${i * 50}ms` }} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : peers?.map((peer) => (
                <TableRow key={peer.peerId}>
                  <TableCell className="font-mono text-sm font-medium">
                    {peer.peerId.slice(0, 16)}...
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground flex items-center gap-2">
                    <Globe className="w-3 h-3" />
                    {peer.address}
                  </TableCell>
                  <TableCell>
                    {peer.connected ? (
                      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                        <Wifi className="w-3 h-3 mr-1" /> Connected
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="bg-gray-50 text-gray-500 border-gray-200">
                        Disconnected
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-medium">{peer.height}</TableCell>
                  <TableCell className="text-right">
                    <span className={peer.latencyMs > 200 ? "text-orange-500" : "text-green-600"}>
                      {peer.latencyMs}ms
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {peers?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No peers connected to the node.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
