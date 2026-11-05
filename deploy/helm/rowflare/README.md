# Rowflare Helm chart

[Rowflare](https://rowflare.com) is an open-source Airtable alternative (AGPL-3.0). This chart runs the official `rowflare/rowflare` image (amd64 and arm64) with a persistent volume for `/data`, where every base, the accounts database and attachments are stored.

## Install

```sh
helm repo add rowflare https://rowflare-oss.github.io/rowflare
helm repo update
helm install rowflare rowflare/rowflare \
  --namespace rowflare --create-namespace \
  --set rowflare.appUrl=https://rowflare.example.com \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=rowflare.example.com \
  --set ingress.hosts[0].paths[0].path=/ \
  --set ingress.hosts[0].paths[0].pathType=Prefix
```

Open the URL and sign up right away: the first account becomes the owner, and everyone else joins by invite.

## How it runs

- One pod (`replicas: 1`, `Recreate` strategy). Rowflare keeps each base in SQLite files on the volume, so it cannot run more than one replica.
- A `ReadWriteOnce` PersistentVolumeClaim (5Gi by default) mounted at `/data`. The claim is annotated `helm.sh/resource-policy: keep`, so `helm uninstall` does not delete your data; delete the PVC yourself when you no longer need it.
- `SECRET_KEY` encrypts credentials that workspace owners save (AI service keys, SMTP passwords). If you do not set `rowflare.secretKey` or `rowflare.existingSecret`, the chart generates a random key on install and keeps it on upgrades. Changing it later makes saved credentials unreadable.
- Real-time collaboration uses WebSockets on `/api/bases/*/ws`. ingress-nginx forwards them by default; raise `proxy-read-timeout` (see `values.yaml`) so idle sockets stay open.

## Values

| Key | Default | Description |
| --- | --- | --- |
| `image.repository` | `docker.io/rowflare/rowflare` | Image |
| `image.tag` | chart `appVersion` | Image tag |
| `image.digest` | digest of 0.1.0 | Pins the image; set to `""` to use the tag only |
| `rowflare.appUrl` | `""` | Public URL, used for absolute links such as invites |
| `rowflare.mode` | `selfhost` | `selfhost`: first account is the owner, others join by invite |
| `rowflare.allowSignup` | `false` | Let anyone who can reach the instance sign up |
| `rowflare.secretKey` | `""` (generated) | Key that encrypts saved credentials |
| `rowflare.existingSecret` | `""` | Use this Secret for `SECRET_KEY` instead |
| `extraEnv`, `extraEnvFrom` | `[]` | Other settings, for example `MAIL_PROVIDER` and `SMTP_*` |
| `persistence.enabled` | `true` | Store `/data` on a PVC (an `emptyDir` otherwise: data is lost on restart) |
| `persistence.existingClaim` | `""` | Use an existing PVC |
| `persistence.storageClass` | `""` | StorageClass (cluster default when empty) |
| `persistence.size` | `5Gi` | Volume size |
| `service.type`, `service.port` | `ClusterIP`, `8787` | Service |
| `ingress.*` | disabled | Standard Ingress settings |
| `resources` | 100m CPU, 256Mi to 1Gi memory | Requests and limits |

All settings Rowflare reads are listed in [docs/self-hosting.md](https://github.com/rowflare-oss/rowflare/blob/main/docs/self-hosting.md).

## Backups

Everything is on the `/data` volume. Snapshot the PVC with your storage provider's tools, or scale the deployment to 0 and copy the volume.

## Upgrading

Change `image.tag` and `image.digest` (or upgrade to a newer chart) and run `helm upgrade`. The pod is recreated; the volume and the generated secret key are kept.
