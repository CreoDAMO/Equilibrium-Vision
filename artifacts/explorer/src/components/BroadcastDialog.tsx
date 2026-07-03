import React, { useState } from "react";
import { useBroadcastTransaction } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Send } from "lucide-react";

export function BroadcastDialog() {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState({
    from: "",
    to: "",
    amount: "1",
    fee: "0.001",
    nonce: "1",
    signature: "0x",
    publicKey: "0x"
  });

  const { toast } = useToast();
  const broadcast = useBroadcastTransaction();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    broadcast.mutate(
      {
        data: {
          from: formData.from,
          to: formData.to,
          amount: parseFloat(formData.amount),
          fee: parseFloat(formData.fee),
          nonce: parseInt(formData.nonce, 10),
          signature: formData.signature,
          publicKey: formData.publicKey
        }
      },
      {
        onSuccess: (data) => {
          toast({
            title: "Transaction Broadcasted",
            description: `Hash: ${data.txHash.slice(0, 10)}...`,
          });
          setOpen(false);
        },
        onError: (err: any) => {
          toast({
            variant: "destructive",
            title: "Broadcast Failed",
            description: err?.message || "Could not broadcast transaction",
          });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Send className="w-4 h-4 mr-2" />
          Broadcast Tx
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Broadcast Transaction</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>From Address</Label>
            <Input 
              required 
              value={formData.from} 
              onChange={e => setFormData({...formData, from: e.target.value})} 
              placeholder="0x..." 
            />
          </div>
          <div className="space-y-2">
            <Label>To Address</Label>
            <Input 
              required 
              value={formData.to} 
              onChange={e => setFormData({...formData, to: e.target.value})} 
              placeholder="0x..." 
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Amount (EQU)</Label>
              <Input 
                required 
                type="number" 
                step="any"
                value={formData.amount} 
                onChange={e => setFormData({...formData, amount: e.target.value})} 
              />
            </div>
            <div className="space-y-2">
              <Label>Fee (EQU)</Label>
              <Input 
                required 
                type="number" 
                step="any"
                value={formData.fee} 
                onChange={e => setFormData({...formData, fee: e.target.value})} 
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Nonce</Label>
            <Input 
              required 
              type="number" 
              value={formData.nonce} 
              onChange={e => setFormData({...formData, nonce: e.target.value})} 
            />
          </div>
          <div className="space-y-2">
            <Label>Signature</Label>
            <Input 
              required 
              value={formData.signature} 
              onChange={e => setFormData({...formData, signature: e.target.value})} 
            />
          </div>
          <div className="space-y-2">
            <Label>Public Key</Label>
            <Input 
              required 
              value={formData.publicKey} 
              onChange={e => setFormData({...formData, publicKey: e.target.value})} 
            />
          </div>
          <Button type="submit" className="w-full" disabled={broadcast.isPending}>
            {broadcast.isPending ? "Broadcasting..." : "Submit Transaction"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
