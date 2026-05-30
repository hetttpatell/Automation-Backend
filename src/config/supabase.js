import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Initialize the Supabase client utilizing the high-privilege SERVICE ROLE KEY.
// Bypassing Row Level Security (RLS) is required here so that backend automated loops
// can safely retrieve tenant configuration, insert chat history, and persist customer leads.
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

/*
=========================================
FILE: src/config/supabase.js
=========================================
DESCRIPTION:
This module initializes and exports the Supabase client instance. It acts as the
primary gateway to the relational database containing our persistent customer tables,
tenant specifications, message histories, and generated leads.

WORKFLOW:
1. Imports createClient from '@supabase/supabase-js' and 'env' from './env.js'.
2. Invokes createClient using the validated SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
3. Exports the instanced 'supabase' client object.

CONNECTION TO OTHER FILES:
- Imports configurations from src/config/env.js to access credentials securely.
- Exported 'supabase' instance is imported by src/services/db.service.js to perform all database operations.
=========================================
*/
