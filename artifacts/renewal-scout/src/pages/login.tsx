import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useLogin, useGetMe } from "@workspace/api-client-react";
import { Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Label } from "@/components/ui/label";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [_, setLocation] = useLocation();
  const login = useLogin();
  const { data: auth, isLoading } = useGetMe();

  useEffect(() => {
    if (!isLoading && auth?.authenticated) {
      setLocation("/");
    }
  }, [isLoading, auth?.authenticated, setLocation]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate({ data: { password } }, {
      onSuccess: () => setLocation("/")
    });
  };

  if (isLoading || auth?.authenticated) return null;

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="h-12 w-12 bg-primary rounded-xl flex items-center justify-center text-primary-foreground shadow-sm mb-4">
            <Shield className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Renewal Scout</h1>
          <p className="text-sm text-muted-foreground mt-1 text-center">
            Your private household renewal dashboard
          </p>
        </div>

        <Card className="shadow-lg border-border/50">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Private Access</CardTitle>
            <CardDescription>Enter your master password to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;"
                  autoFocus
                />
              </div>
              {login.isError && (
                <p className="text-sm text-destructive font-medium">
                  {login.error?.data?.error || "Incorrect password"}
                </p>
              )}
              <Button type="submit" className="w-full" disabled={login.isPending || !password}>
                {login.isPending ? "Unlocking..." : "Unlock"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
