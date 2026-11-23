@echo off
cd /d "c:\Users\Nuelthewave\Desktop\Veridatum Pr\earnproof-backend"

REM Create a new branch with timestamp
for /f "tokens=2-4 delims=/ " %%a in ('date /t') do (set mydate=%%c%%a%%b)
for /f "tokens=1-2 delims=/:" %%a in ('time /t') do (set mytime=%%a%%b)
set newbranch=merge/consolidated-%mydate%-%mytime%

echo Creating new branch: %newbranch%
git checkout -b %newbranch%

echo Merging feat/issue-334-offline-verification-bundles...
git merge feat/issue-334-offline-verification-bundles --no-edit

echo Merging feat/project-revocation-checkpoint-commitments...
git merge feat/project-revocation-checkpoint-commitments --no-edit

echo Merging feature/issue-332-contract-state-reconciliation...
git merge feature/issue-332-contract-state-reconciliation --no-edit

echo Merging feat/record-one-time-secret-retrieval-receipts...
git merge feat/record-one-time-secret-retrieval-receipts --no-edit

echo All branches merged successfully!
git log --oneline -5

echo Pushing to remote...
git push -u origin %newbranch%

echo Done!
