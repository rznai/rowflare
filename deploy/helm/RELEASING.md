# Publishing the Helm chart

The chart lives in `deploy/helm/rowflare`. `.github/workflows/helm-release.yml` packages it with
[chart-releaser](https://github.com/helm/chart-releaser-action) whenever the `version` in `Chart.yaml` changes on
`main`, attaches the package to a GitHub release named `rowflare-<version>`, and updates `index.yaml` on the
`gh-pages` branch, which GitHub Pages serves as the Helm repository `https://rowflare-oss.github.io/rowflare`.

## One-time setup

1. Create the `gh-pages` branch with nothing on it:

   ```sh
   git switch --orphan gh-pages
   git commit --allow-empty -m "Helm repository"
   git push origin gh-pages
   git switch main
   ```

2. Settings, Pages: deploy from the `gh-pages` branch, folder `/ (root)`.
3. Settings, Actions, General, Workflow permissions: "Read and write permissions".
4. Push to `main`. The workflow creates the release `rowflare-0.1.0` and `index.yaml`.
5. Check: `helm repo add rowflare https://rowflare-oss.github.io/rowflare && helm search repo rowflare`.
6. On [artifacthub.io](https://artifacthub.io), sign in, Control Panel, Repositories, Add: kind "Helm charts",
   name `rowflare`, URL `https://rowflare-oss.github.io/rowflare`. Copy the repository ID into
   `deploy/helm/artifacthub-repo.yml` (`repositoryID:`) and push, to get the "Verified publisher" badge.
   Artifact Hub scans the repository every 30 minutes or so.

## Each release

Bump `version` in `Chart.yaml` (and `appVersion`, `image.digest` in `values.yaml` and the `artifacthub.io/images`
and `artifacthub.io/changes` annotations when the app changes). A chart version that already has a release is
skipped, so unchanged versions are never republished.
