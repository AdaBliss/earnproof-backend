@echo off
setlocal enabledelayedexpansion

cd /d "c:\Users\Nuelthewave\Desktop\Veridatum Pr\earnproof-backend"

echo Creating new merge branch...
git checkout -b merge/consolidated-features-20261015

echo.
echo Merging feat/issue-334-offline-verification-bundles...
git merge feat/issue-334-offline-verification-bundles --no-edit
if errorlevel 1 (
    echo Failed to merge first branch
    exit /b 1
)

echo.
echo Merging feat/project-revocation-checkpoint-commitments...
git merge feat/project-revocation-checkpoint-commitments --no-edit
if errorlevel 1 (
    echo Failed to merge second branch
    exit /b 1
)

echo.
echo Merging feature/issue-332-contract-state-reconciliation...
git merge feature/issue-332-contract-state-reconciliation --no-edit
if errorlevel 1 (
    echo Failed to merge third branch
    exit /b 1
)

echo.
echo Merging feat/record-one-time-secret-retrieval-receipts...
git merge feat/record-one-time-secret-retrieval-receipts --no-edit
if errorlevel 1 (
    echo Failed to merge fourth branch
    exit /b 1
)

echo.
echo All merges completed successfully!
echo.
echo Recent commits:
git log --oneline -10

echo.
echo Pushing to remote...
git push -u origin merge/consolidated-features-20261015
if errorlevel 1 (
    echo Failed to push
    exit /b 1
)

echo.
echo SUCCESS! Branch merge/consolidated-features-20261015 created and pushed!
pause
