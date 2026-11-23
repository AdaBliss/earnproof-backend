# Merge multiple branches into a new branch
$repoPath = "c:\Users\Nuelthewave\Desktop\Veridatum Pr\earnproof-backend"
Set-Location $repoPath

# Define the branches to merge
$branches = @(
    "feat/issue-334-offline-verification-bundles",
    "feat/project-revocation-checkpoint-commitments",
    "feature/issue-332-contract-state-reconciliation",
    "feat/record-one-time-secret-retrieval-receipts"
)

# Create a new branch name based on current timestamp
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$newBranchName = "merge/consolidated-$timestamp"

Write-Host "Creating new branch: $newBranchName"
git checkout -b $newBranchName

Write-Host "Merging branches..."
foreach ($branch in $branches) {
    Write-Host "Merging $branch..."
    git merge $branch --no-edit
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Error merging $branch. Resolve conflicts and continue."
        exit 1
    }
}

Write-Host "All branches merged successfully!"
Write-Host "New branch: $newBranchName"

# Show the merge result
git log --oneline -10
