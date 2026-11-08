export interface Verification {
    level: string; // e.g., 'none' | 'verified'
    since: string | null;
}

export interface Account {
    account_id: string;
    display_name: string;
    membership_role: string; // e.g., 'owner' | 'member' | 'admin'
    slug: string;
    verification: Verification;
}

export interface Balances {
    credit_usd: string;
    usd: string;
    usdc: string;
}

export interface Client {
    protocol_version: string;
    user_agent: string;
}

export interface Server {
    protocol_version: string;
    skill_url: string;
    skill_version: string;
    tools: string[];
    version: string;
}

export interface User {
    display_name: string;
    email: string;
    email_verification_required: boolean;
    email_verified: boolean;
    handle: string;
    role: string; // e.g., 'user' | 'admin'
    user_id: string;
}

export interface WhoamiResponse {
    account: Account;
    accounts: Account[];
    balances: Balances;
    client: Client;
    marketplace: string;
    note: string;
    server: Server;
    update_hint: string | null;
    user: User;
}
