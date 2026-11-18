#!/usr/bin/env python3

import subprocess
import os
import sys
from datetime import datetime

repo_path = r"c:\Users\Nuelthewave\Desktop\Veridatum Pr\earnproof-backend"
branches = [
    "feat/issue-334-offline-verification-bundles",
    "feat/project-revocation-checkpoint-commitments",
    "feature/issue-332-contract-state-reconciliation",
    "feat/record-one-time-secret-retrieval-receipts"
]

os.chdir(repo_path)

def run_git(command):
    """Run a git command"""
    try:
        result = subprocess.run(f"git {command}", shell=True, capture_output=True, text=True, check=True)
        print(result.stdout)
        return result.returncode == 0
    except subprocess.CalledProcessError as e:
        print(f"Error: {e.stderr}")
        return False

try:
    # Create new branch with timestamp
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    new_branch = f"merge/consolidated-{timestamp}"
    
    print(f"\n🔄 Creating new branch: {new_branch}\n")
    if not run_git(f"checkout -b {new_branch}"):
        sys.exit(1)
    
    # Merge all branches
    print(f"\n📦 Starting merges...\n")
    for branch in branches:
        print(f"\n➕ Merging: {branch}")
        if not run_git(f"merge {branch} --no-edit"):
            print(f"❌ Failed to merge {branch}")
            sys.exit(1)
        print(f"✅ Successfully merged: {branch}")
    
    print(f"\n✨ All branches merged successfully!\n")
    
    # Show commit log
    print(f"\n📋 Recent commits:\n")
    run_git("log --oneline -10")
    
    # Push to remote
    print(f"\n🚀 Pushing to remote...\n")
    if not run_git(f"push -u origin {new_branch}"):
        print(f"❌ Failed to push {new_branch}")
        sys.exit(1)
    
    print(f"\n✅ Branch {new_branch} created, merged, and pushed successfully!\n")
    
except Exception as e:
    print(f"\n❌ Error: {str(e)}\n")
    sys.exit(1)
