"use client";

import * as React from "react";
import { api, ApiError } from "../../../models/api-client.ts";
import type { IssuedApiKey, UsagePlan } from "../../../models/types.ts";
import { PageHeader, ErrorText, SuccessText } from "../../../components/ui/feedback.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card.tsx";
import { Button } from "../../../components/ui/button.tsx";
import { Input, Label } from "../../../components/ui/input.tsx";

/** Parse the optional plan fields; empty → undefined (portal default applies). */
function planFrom(rate: string, burst: string, quota: string): Partial<UsagePlan> {
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  return { rateLimitPerSec: num(rate), burst: num(burst), monthlyQuota: num(quota) };
}

/** Get auth token from session storage */
function getAuthToken(): string | null {
  if (typeof window !== "undefined") {
    const storedAccount = sessionStorage.getItem("pdm_account");
    if (storedAccount) {
      try {
        const account = JSON.parse(storedAccount);
        return account.token || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function DhruApiSection() {
  const [accountId, setAccountId] = React.useState("");
  const [credentials, setCredentials] = React.useState<any>(null);
  const [ipWhitelist, setIpWhitelist] = React.useState<any>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [checkingCreds, setCheckingCreds] = React.useState(false);
  const [showAccessKey, setShowAccessKey] = React.useState(false);
  const [currentUser, setCurrentUser] = React.useState<any>(null);

  // Get current user info from session storage
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const storedAccount = sessionStorage.getItem("pdm_account");
      if (storedAccount) {
        try {
          const account = JSON.parse(storedAccount);
          setCurrentUser(account);
          // If user is a distributor, auto-fill their account ID
          if (account.role === "distributor" && account.accountId) {
            setAccountId(account.accountId);
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }, []);

  // Check for existing credentials when account ID changes
  React.useEffect(() => {
    const checkExisting = async () => {
      const trimmedId = accountId.trim();
      if (!trimmedId) {
        setCredentials(null);
        return;
      }

      setCheckingCreds(true);
      try {
        const token = getAuthToken();
        const headers: Record<string, string> = {};
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(`/api/resellers/${trimmedId}/dhru-api-key`, {
          headers,
        });
        
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.hasCredentials) {
            setCredentials(data.credentials);
          } else {
            setCredentials(null);
          }
        } else {
          setCredentials(null);
        }

        // Also fetch IP whitelist status
        const ipResponse = await fetch(`/api/resellers/${trimmedId}/dhru-ip-whitelist`, {
          headers,
        });
        if (ipResponse.ok) {
          const ipData = await ipResponse.json();
          if (ipData.success) {
            setIpWhitelist(ipData.ipBinding);
          }
        }
      } catch (err) {
        setCredentials(null);
        setIpWhitelist(null);
      } finally {
        setCheckingCreds(false);
      }
    };

    const timeoutId = setTimeout(checkExisting, 500);
    return () => clearTimeout(timeoutId);
  }, [accountId]);

  async function handleGenerateCredentials(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`/api/resellers/${accountId.trim()}/dhru-api-key`, {
        method: "POST",
        headers,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to generate credentials");
      }

      setCredentials(data.credentials);
      setSuccess("Dhru API credentials generated successfully!");
      setShowAccessKey(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate credentials");
    } finally {
      setLoading(false);
    }
  }

  async function handleRevokeCredentials() {
    if (!confirm("Are you sure you want to revoke these credentials? The reseller will no longer be able to use them.")) {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`/api/resellers/${accountId.trim()}/dhru-api-key`, {
        method: "DELETE",
        headers,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to revoke credentials");
      }

      setCredentials(null);
      setSuccess("Credentials revoked successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke credentials");
    } finally {
      setLoading(false);
    }
  }

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setSuccess(`${label} copied to clipboard!`);
    setTimeout(() => setSuccess(null), 2000);
  }

  async function handleEnableIpBinding() {
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`/api/resellers/${accountId.trim()}/dhru-ip-whitelist`, {
        method: "POST",
        headers,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to enable IP binding");
      }

      setSuccess("IP binding enabled! The first API request will bind the IP address.");
      
      // Refresh IP whitelist status
      const ipResponse = await fetch(`/api/resellers/${accountId.trim()}/dhru-ip-whitelist`, {
        headers,
      });
      if (ipResponse.ok) {
        const ipData = await ipResponse.json();
        if (ipData.success) {
          setIpWhitelist(ipData.ipBinding);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to enable IP binding");
    } finally {
      setLoading(false);
    }
  }

  async function handleResetIp() {
    if (!confirm("Are you sure you want to reset the IP whitelist? The next API request will bind a new IP address.")) {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`/api/resellers/${accountId.trim()}/dhru-ip-whitelist`, {
        method: "DELETE",
        headers,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to reset IP binding");
      }

      setSuccess("IP whitelist reset! The next API request will bind a new IP address.");
      
      // Refresh IP whitelist status
      const ipResponse = await fetch(`/api/resellers/${accountId.trim()}/dhru-ip-whitelist`, {
        headers,
      });
      if (ipResponse.ok) {
        const ipData = await ipResponse.json();
        if (ipData.success) {
          setIpWhitelist(ipData.ipBinding);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset IP binding");
    } finally {
      setLoading(false);
    }
  }

  async function handleDisableIpBinding() {
    if (!confirm("Are you sure you want to disable IP binding? API requests will be accepted from any IP address.")) {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`/api/resellers/${accountId.trim()}/dhru-ip-whitelist`, {
        method: "PATCH",
        headers,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to disable IP binding");
      }

      setSuccess("IP binding disabled. API requests will be accepted from any IP.");
      
      // Refresh IP whitelist status
      const ipResponse = await fetch(`/api/resellers/${accountId.trim()}/dhru-ip-whitelist`, {
        headers,
      });
      if (ipResponse.ok) {
        const ipData = await ipResponse.json();
        if (ipData.success) {
          setIpWhitelist(ipData.ipBinding);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable IP binding");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Generate Dhru API Credentials</CardTitle>
          <CardDescription>
            Create Dhru-compatible API credentials for resellers to sell PDM licenses through their Dhru panels
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleGenerateCredentials} className="flex flex-col gap-4">
            {currentUser?.role === "super_admin" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="dhru-account-id">Reseller Account ID</Label>
                <Input
                  id="dhru-account-id"
                  placeholder="acc_xxxxx"
                  required
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                />
                {checkingCreds && (
                  <p className="text-xs text-gray-500">Checking existing credentials...</p>
                )}
              </div>
            )}

            {currentUser?.role === "distributor" && (
              <div className="rounded-md bg-gray-50 border border-gray-200 p-3">
                <p className="text-sm text-gray-700">
                  <strong>Account:</strong> {accountId || "Loading..."}
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Credentials will be generated for your account
                </p>
              </div>
            )}

            {credentials ? (
              <div className="rounded-md bg-blue-50 border border-blue-200 p-4">
                <h4 className="font-semibold text-blue-900 mb-3">Existing Credentials</h4>
                
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs text-gray-600">Username</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="flex-1 block rounded bg-white p-2 font-mono text-sm border">
                        {credentials.username}
                      </code>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => copyToClipboard(credentials.username, "Username")}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs text-gray-600">API Access Key</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="flex-1 block rounded bg-white p-2 font-mono text-sm border">
                        {showAccessKey ? credentials.accessKey : "••••••••••••••••••••••••"}
                      </code>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setShowAccessKey(!showAccessKey)}
                      >
                        {showAccessKey ? "Hide" : "Show"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => copyToClipboard(credentials.accessKey, "API Key")}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs text-gray-600">API Endpoint</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="flex-1 block rounded bg-white p-2 font-mono text-xs border break-all">
                        {credentials.fullEndpoint}
                      </code>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => copyToClipboard(credentials.fullEndpoint, "Endpoint")}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>

                  {credentials.createdAt && (
                    <p className="text-xs text-gray-500 pt-2 border-t">
                      Created: {new Date(credentials.createdAt).toLocaleString()}
                    </p>
                  )}
                </div>

                {/* IP Whitelist Section */}
                {ipWhitelist && (
                  <div className="mt-4 pt-4 border-t border-blue-200">
                    <h4 className="font-semibold text-blue-900 mb-3">🔒 IP Whitelist Security</h4>
                    
                    {ipWhitelist.enabled ? (
                      <div className="space-y-3">
                        <div className="rounded-md bg-green-50 border border-green-200 p-3">
                          <p className="text-xs font-semibold text-green-800 mb-2">✓ IP Binding Enabled</p>
                          
                          {ipWhitelist.whitelistedIp ? (
                            <>
                              <div className="flex items-center justify-between">
                                <span className="text-xs text-gray-600">Whitelisted IP:</span>
                                <code className="text-xs font-mono font-semibold text-green-700">
                                  {ipWhitelist.whitelistedIp}
                                </code>
                              </div>
                              
                              {ipWhitelist.lastUsedAt && (
                                <p className="text-xs text-gray-500 mt-2">
                                  Last used: {new Date(ipWhitelist.lastUsedAt).toLocaleString()}
                                </p>
                              )}
                              
                              <div className="mt-3 pt-3 border-t border-green-200 flex gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={loading}
                                  onClick={handleResetIp}
                                >
                                  🔄 Reset IP
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="danger"
                                  disabled={loading}
                                  onClick={handleDisableIpBinding}
                                >
                                  Disable IP Binding
                                </Button>
                              </div>
                            </>
                          ) : (
                            <>
                              <p className="text-xs text-gray-600">
                                No IP bound yet. The first API request will automatically bind the IP address.
                              </p>
                              
                              {ipWhitelist.lastUsedIp && (
                                <p className="text-xs text-gray-500 mt-2">
                                  Most recent request from: <code className="font-mono">{ipWhitelist.lastUsedIp}</code>
                                </p>
                              )}
                              
                              <div className="mt-3 pt-3 border-t border-green-200">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="danger"
                                  disabled={loading}
                                  onClick={handleDisableIpBinding}
                                >
                                  Disable IP Binding
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                        
                        <div className="text-xs text-gray-600 space-y-1">
                          <p>ℹ️ <strong>IP Binding Active:</strong></p>
                          <ul className="list-disc list-inside pl-2 space-y-1">
                            <li>API requests are only accepted from the whitelisted IP</li>
                            <li>Compromised credentials cannot be used from other IPs</li>
                            <li>Click "Reset IP" to clear and rebind on next request</li>
                          </ul>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="rounded-md bg-yellow-50 border border-yellow-200 p-3">
                          <p className="text-xs font-semibold text-yellow-800 mb-2">⚠ IP Binding Disabled</p>
                          <p className="text-xs text-gray-600">
                            API requests are accepted from any IP address. Enable IP binding for enhanced security.
                          </p>
                          
                          {ipWhitelist.lastUsedIp && (
                            <p className="text-xs text-gray-500 mt-2">
                              Most recent request from: <code className="font-mono">{ipWhitelist.lastUsedIp}</code>
                              {ipWhitelist.lastUsedAt && (
                                <> at {new Date(ipWhitelist.lastUsedAt).toLocaleString()}</>
                              )}
                            </p>
                          )}
                          
                          <div className="mt-3 pt-3 border-t border-yellow-200">
                            <Button
                              type="button"
                              size="sm"
                              disabled={loading}
                              onClick={handleEnableIpBinding}
                            >
                              🔒 Enable IP Binding
                            </Button>
                          </div>
                        </div>
                        
                        <div className="text-xs text-gray-600 space-y-1">
                          <p>💡 <strong>Enable IP Binding for:</strong></p>
                          <ul className="list-disc list-inside pl-2 space-y-1">
                            <li>Protection against credential theft</li>
                            <li>Automatic binding to first request IP</li>
                            <li>Easy reset for IP changes</li>
                          </ul>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="mt-4 pt-4 border-t border-blue-200">
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={loading}
                    onClick={handleRevokeCredentials}
                  >
                    {loading ? "Revoking..." : "Revoke Credentials"}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {error && <ErrorText>{error}</ErrorText>}
                {success && <SuccessText>{success}</SuccessText>}

                <Button type="submit" disabled={loading || !accountId.trim() || checkingCreds}>
                  {loading ? "Generating..." : "Generate Credentials"}
                </Button>
              </>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dhru API Integration Guide</CardTitle>
          <CardDescription>How resellers integrate PDM into their Dhru panels</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm">
            <div>
              <h4 className="font-semibold mb-2">📋 Setup Instructions:</h4>
              <ol className="list-decimal list-inside space-y-1 text-gray-600">
                <li>Generate credentials for reseller account above</li>
                <li>Share username, API key, and endpoint with reseller</li>
                <li>Reseller adds API service in their Dhru panel</li>
                <li>Orders placed automatically deduct from PDM balance</li>
              </ol>
            </div>

            <div>
              <h4 className="font-semibold mb-2">🎯 Available Services:</h4>
              <ul className="list-disc list-inside space-y-1 text-gray-600">
                <li><strong>PDM3M</strong> - 3 Months License (1 credit)</li>
                <li><strong>PDM6M</strong> - 6 Months License (2 credits)</li>
                <li><strong>PDM12M</strong> - 12 Months License (3 credits)</li>
              </ul>
            </div>

            <div>
              <h4 className="font-semibold mb-2">💰 Pricing & Balance:</h4>
              <p className="text-gray-600">
                Each license purchase deducts credits from the reseller's PDM wallet balance.
                Ensure resellers have sufficient balance before they can process orders.
              </p>
            </div>

            <div>
              <h4 className="font-semibold mb-2">🔐 Supported Actions:</h4>
              <ul className="list-disc list-inside space-y-1 text-gray-600">
                <li><code className="text-xs">accountinfo</code> - Check balance</li>
                <li><code className="text-xs">imeiservicelist</code> - List services</li>
                <li><code className="text-xs">placeimeiorder</code> - Purchase license</li>
                <li><code className="text-xs">imeiorderdetails</code> - Get license key</li>
              </ul>
            </div>

            <div className="pt-4 border-t">
              <p className="text-xs text-gray-500">
                <strong>Note:</strong> Each reseller needs unique credentials. Orders are
                instant and license keys are returned immediately in the response.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function ApiKeysPage() {
  return (
    <>
      <PageHeader title="API keys" description="Issue, revoke, and re-plan reseller API keys." />
      
      {/* Dhru API Integration Section */}
      <div className="mb-8">
        <h2 className="text-2xl font-bold mb-4">Dhru API Integration</h2>
        <DhruApiSection />
      </div>

      {/* Existing API Keys Management */}
      <h2 className="text-2xl font-bold mb-4">Portal API Keys</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        <IssueKey />
        <div className="flex flex-col gap-6">
          <RevokeKey />
          <ChangePlan />
        </div>
      </div>
    </>
  );
}

function PlanFields({
  rate, burst, quota, setRate, setBurst, setQuota,
}: {
  rate: string; burst: string; quota: string;
  setRate: (v: string) => void; setBurst: (v: string) => void; setQuota: (v: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rate">Rate/sec</Label>
        <Input id="rate" type="number" min={0} placeholder="default" value={rate} onChange={(e) => setRate(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="burst">Burst</Label>
        <Input id="burst" type="number" min={0} placeholder="default" value={burst} onChange={(e) => setBurst(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="quota">Monthly quota</Label>
        <Input id="quota" type="number" min={0} placeholder="default" value={quota} onChange={(e) => setQuota(e.target.value)} />
      </div>
    </div>
  );
}

function IssueKey() {
  const [resellerId, setResellerId] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [burst, setBurst] = React.useState("");
  const [quota, setQuota] = React.useState("");
  const [issued, setIssued] = React.useState<IssuedApiKey | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [checkingBalance, setCheckingBalance] = React.useState(false);
  const [balanceInfo, setBalanceInfo] = React.useState<{ balance: number; cost: number; discount: number } | null>(null);

  // Check balance when reseller ID changes
  React.useEffect(() => {
    const checkBalance = async () => {
      const trimmedId = resellerId.trim();
      if (!trimmedId) {
        setBalanceInfo(null);
        return;
      }

      setCheckingBalance(true);
      try {
        const balance = await api.getBalance(trimmedId);
        // Base API key price is 100 credits
        // In future, fetch actual price calculation from backend
        const basePrice = 100;
        const cost = basePrice; // Will include discount calculation from backend
        setBalanceInfo({ balance: balance.balance, cost, discount: 0 });
      } catch (err) {
        // Silently ignore - account might not exist yet or user has no permission
        setBalanceInfo(null);
      } finally {
        setCheckingBalance(false);
      }
    };

    const timeoutId = setTimeout(checkBalance, 500); // Debounce
    return () => clearTimeout(timeoutId);
  }, [resellerId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Check balance before submission
    if (balanceInfo && balanceInfo.balance < balanceInfo.cost) {
      setError(`Insufficient balance. Required: ${balanceInfo.cost} credits, Available: ${balanceInfo.balance} credits.`);
      return;
    }

    // Store pre-transaction balance for display
    const preBalance = balanceInfo?.balance || 0;

    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const result = await api.issueApiKey(resellerId.trim(), planFrom(rate, burst, quota));
      setIssued(result);
      
      // Refresh balance after successful creation to show updated amount
      try {
        const updatedBalance = await api.getBalance(resellerId.trim());
        // Update balance but keep the original for display in success message
        if (balanceInfo) {
          setBalanceInfo({ ...balanceInfo, balance: preBalance });
        }
      } catch {
        // Ignore balance refresh errors
      }
    } catch (err) {
      setError(err instanceof ApiError ? `${err.field ? err.field + ": " : ""}${err.message}` : "Issue failed");
    } finally {
      setBusy(false);
    }
  }

  const hasInsufficientBalance = balanceInfo && balanceInfo.balance < balanceInfo.cost;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Issue API key</CardTitle>
        <CardDescription>The secret is shown once — copy it now.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rid">Reseller account ID</Label>
            <Input id="rid" required value={resellerId} onChange={(e) => setResellerId(e.target.value)} />
          </div>

          {checkingBalance && (
            <div className="text-sm text-gray-500">Checking balance...</div>
          )}

          {balanceInfo && !checkingBalance && (
            <div className={`rounded-md p-3 text-sm ${hasInsufficientBalance ? "bg-red-50 border border-red-200" : "bg-blue-50 border border-blue-200"}`}>
              <div className="flex justify-between items-center">
                <span className="text-gray-700">Account Balance:</span>
                <span className={`font-mono font-semibold ${hasInsufficientBalance ? "text-red-600" : "text-blue-800"}`}>
                  {balanceInfo.balance.toLocaleString()} credits
                </span>
              </div>
              <div className="flex justify-between items-center mt-1">
                <span className="text-gray-700">API Key Cost:</span>
                <span className="font-mono font-semibold text-gray-800">{balanceInfo.cost.toLocaleString()} credits</span>
              </div>
              {hasInsufficientBalance && (
                <div className="mt-2 text-red-700 font-medium">
                  ⚠️ Insufficient balance to create API key
                </div>
              )}
            </div>
          )}

          <PlanFields rate={rate} burst={burst} quota={quota} setRate={setRate} setBurst={setBurst} setQuota={setQuota} />
          {error && <ErrorText>{error}</ErrorText>}
          {issued && (
            <div className="rounded-md bg-green-50 border border-green-200 p-3 text-sm">
              <SuccessText>API key issued successfully!</SuccessText>
              <p className="mt-1 text-xs">Key ID: <span className="font-mono">{issued.apiKeyId}</span></p>
              <p className="mt-1 text-xs">Secret (copy now):</p>
              <code className="mt-1 block break-all rounded bg-white p-2 font-mono text-xs">{issued.secret}</code>
              
              {balanceInfo && (
                <div className="mt-3 pt-3 border-t border-green-200">
                  <div className="text-xs font-semibold text-gray-700 mb-1">Transaction Summary:</div>
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <span className="text-gray-600">Cost:</span>
                    <span className="font-mono text-right">-{balanceInfo.cost.toLocaleString()} credits</span>
                    
                    {balanceInfo.discount > 0 && (
                      <>
                        <span className="text-gray-600">Discount Applied:</span>
                        <span className="font-mono text-right text-green-600">{balanceInfo.discount}%</span>
                      </>
                    )}
                    
                    <span className="text-gray-600">Previous Balance:</span>
                    <span className="font-mono text-right">{balanceInfo.balance.toLocaleString()} credits</span>
                    
                    <span className="text-gray-700 font-semibold">New Balance:</span>
                    <span className="font-mono text-right font-semibold text-blue-700">
                      {(balanceInfo.balance - balanceInfo.cost).toLocaleString()} credits
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
          <div>
            <Button type="submit" disabled={busy || hasInsufficientBalance}>
              {busy ? "Issuing…" : "Issue key"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function RevokeKey() {
  const [id, setId] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onRevoke() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.revokeApiKey(id.trim());
      setNotice(`Key ${res.apiKeyId} is now ${res.state}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Revoke failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Revoke key</CardTitle></CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="revid">API key ID</Label>
            <Input id="revid" value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          {notice && <SuccessText>{notice}</SuccessText>}
          <div><Button variant="danger" size="sm" disabled={busy || !id.trim()} onClick={onRevoke}>Revoke</Button></div>
        </div>
      </CardContent>
    </Card>
  );
}

function ChangePlan() {
  const [id, setId] = React.useState("");
  const [rate, setRate] = React.useState("");
  const [burst, setBurst] = React.useState("");
  const [quota, setQuota] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.changeApiKeyPlan(id.trim(), planFrom(rate, burst, quota));
      setNotice(`Updated plan for ${res.apiKeyId}: ${res.usagePlan.rateLimitPerSec}/s, burst ${res.usagePlan.burst}, quota ${res.usagePlan.monthlyQuota}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Change usage plan</CardTitle></CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="planid">API key ID</Label>
            <Input id="planid" required value={id} onChange={(e) => setId(e.target.value)} />
          </div>
          <PlanFields rate={rate} burst={burst} quota={quota} setRate={setRate} setBurst={setBurst} setQuota={setQuota} />
          {error && <ErrorText>{error}</ErrorText>}
          {notice && <SuccessText>{notice}</SuccessText>}
          <div><Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Update plan"}</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}
