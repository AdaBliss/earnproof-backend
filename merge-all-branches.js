#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

const repoPath = "c:\\Users\\Nuelthewave\\Desktop\\Veridatum Pr\\earnproof-backend";
const branches = [
    "feat/issue-334-offline-verification-bundles",
    "feat/project-revocation-checkpoint-commitments",
    "feature/issue-332-contract-state-reconciliation",
    "feat/record-one-time-secret-retrieval-receipts"
];

const options = { cwd: repoPath, stdio: 'inherit' };

try {
    // Create new branch with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '-' + Date.now().toString().slice(-6);
    const newBranchName = `merge/consolidated-${timestamp}`;
    
    console.log(`\n🔄 Creating new branch: ${newBranchName}\n`);
    execSync(`git checkout -b ${newBranchName}`, options);
    
    // Merge all branches
    console.log(`\n📦 Starting merges...\n`);
    for (const branch of branches) {
        console.log(`\n➕ Merging: ${branch}`);
        execSync(`git merge ${branch} --no-edit`, options);
        console.log(`✅ Successfully merged: ${branch}`);
    }
    
    console.log(`\n✨ All branches merged successfully!\n`);
    
    // Show commit log
    console.log(`\n📋 Recent commits:\n`);
    execSync(`git log --oneline -10`, options);
    
    // Push to remote
    console.log(`\n🚀 Pushing to remote...\n`);
    execSync(`git push -u origin ${newBranchName}`, options);
    
    console.log(`\n✅ Branch ${newBranchName} created, merged, and pushed successfully!\n`);
    
} catch (error) {
    console.error(`\n❌ Error: ${error.message}\n`);
    process.exit(1);
}
