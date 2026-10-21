#!/usr/bin/env node
/**
 * Get Firebase UID for a user by email
 * Usage: node scripts/get-firebase-uid.mjs <email>
 */

import { getAuth } from "firebase-admin/auth";
import admin from "firebase-admin";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Get email from command line
const email = process.argv[2];

if (!email) {
  console.error("Usage: node get-firebase-uid.mjs <email>");
  console.error("Provide the email address of the Firebase user to look up.");
  process.exit(1);
}

try {
  // Initialize Firebase Admin if not already initialized
  if (!admin.apps.length) {
    const serviceAccountPath = join(__dirname, "..", "firebase-service-account.json");
    const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }

  // Get user by email
  const auth = getAuth();
  const userRecord = await auth.getUserByEmail(email);
  
  console.log("");
  console.log("=" .repeat(70));
  console.log("Firebase User Found");
  console.log("=".repeat(70));
  console.log("");
  console.log("Email:", userRecord.email);
  console.log("UID:", userRecord.uid);
  console.log("Created:", new Date(userRecord.metadata.creationTime).toISOString());
  console.log("Last Sign In:", userRecord.metadata.lastSignInTime || "Never");
  console.log("Email Verified:", userRecord.emailVerified);
  console.log("");
  console.log("=".repeat(70));
  console.log("");
  console.log("To add this user to pdm-portal-admins, run:");
  console.log("");
  console.log(`  cd deploy\\dynamodb`);
  console.log(`  .\\add-admin-quick.ps1 -FirebaseUid "${userRecord.uid}"`);
  console.log("");
  console.log("=".repeat(70));
  
  process.exit(0);
} catch (error) {
  console.error("");
  console.error("ERROR:", error.message);
  console.error("");
  
  if (error.code === "auth/user-not-found") {
    console.error("User not found in Firebase Authentication.");
    console.error("");
    console.error("To create the user:");
    console.error("  1. Go to: https://console.firebase.google.com");
    console.error("  2. Select project: perfect-download-manager");
    console.error("  3. Navigate to: Authentication → Users");
    console.error("  4. Click 'Add user'");
    console.error("  5. Email: " + email);
    console.error("  6. Set a unique password directly in Firebase; never store it in source control.");
    console.error("");
  }
  
  process.exit(1);
}
