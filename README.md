# Jukebox da Galera

Jukebox colaborativa: convidados pedem músicas pelo celular, enquanto um anfitrião reproduz no telão ou em um celular conectado à caixa de som. O modo Desafio inclui votação, munição de dislikes e ranking.

## Executar

Requer Node.js 22 ou superior (Docker usa Node 24).

```powershell
npm ci
npm start
```

Abra `http://localhost:3456/tv` no aparelho que vai tocar. O terminal mostra um código de anfitrião: informe-o quando solicitado. No celular, o botão **Anfitrião** libera os controles e o modo JBL. Os convidados entram pelo QR Code, escolhem um nome e podem pedir e votar sem esse código.

Somente o aparelho ativo controla os eventos de reprodução. Ao transferir a reprodução, o anterior para; ao perder conexão, ele também interrompe o áudio. O navegador pode exigir um toque em **Continuar** para liberar som.

No celular, escolha **Só áudio · mais leve** ou **Com vídeo** antes de tocar. Só áudio é o padrão: usa um reprodutor de áudio e solicita apenas a faixa de áudio; o clipe só é extraído e carregado quando escolhido. A escolha fica salva no navegador. **Modo Livre** e **Modo Desafio** controlam a votação, independentemente do formato de reprodução.

Se o navegador bloquear o início automático, toque em **Tocar música**. A tela distingue carregamento, pausa, reprodução e erro. Em caso de falha, há **Tentar novamente** e **Próxima**. Se o servidor de hospedagem não conseguir obter a mídia no YouTube, isso aparece como indisponibilidade; a interface não informa que está tocando antes de receber o evento real do player.

O primeiro início baixa o yt-dlp. Fora de um serviço de nuvem, o aplicativo também abre um túnel público para convidados em 4G/5G. Para usar apenas a rede local:

```powershell
$env:DISABLE_TUNNEL = '1'
npm start
```

## Configuração

Defina as variáveis no terminal antes de iniciar, ou nas configurações da hospedagem. O aplicativo não carrega `.env` automaticamente.

| Variável | Uso |
| --- | --- |
| `PORT` | Porta HTTP; padrão `3456`. |
| `HOST_PIN` | Código de anfitrião de 6 a 128 caracteres. Sem configuração, gera um novo código de 8 dígitos a cada início. |
| `PUBLIC_URL` | URL pública para o QR Code. Render e Railway também são detectados. |
| `DISABLE_TUNNEL` | `1` desativa o túnel automático. |
| `DATA_DIR` | Diretório persistente; padrão `./data`. |
| `MEDIA_ORIGIN` | Origem HTTPS de outro servidor Jukebox que fornecerá o áudio, por exemplo o túnel do computador da festa. Sem essa variável, extrai a mídia no próprio servidor. |
| `YTDLP_CLIENT` | Cliente do extrator; `mweb` habilita a tentativa com validação de origem. Depende da disponibilidade no provedor. |
| `YTDLP_PLUGIN_DIR` | Diretório de plugins do extrator; configurado pela imagem Docker. |
| `MEDIA_DIAGNOSTICS_VIDEO` | ID opcional de vídeo para testar extração nativa no início, mesmo quando há `MEDIA_ORIGIN`. Remova após o diagnóstico. |
| `TRUST_PROXY_HOPS` | Número de proxies confiáveis à frente do servidor, somente se conhecido. Afeta limites HTTP por IP. |

O código aparece no terminal para o operador; não compartilhe logs contendo esse código com convidados. A sessão de anfitrião fica na aba e expira após reiniciar o servidor. A identidade de participante fica no navegador; limpar os dados ou usar outro endereço cria uma nova identidade.

## Recuperação da festa

Fila, histórico, pontuação e participantes são salvos atomicamente em `data/party.json`, após 200 ms sem mudanças e no encerramento normal. A música atual volta pausada, do início, preservando os votos. Participantes reaparecem como desconectados até entrarem novamente. Uma interrupção abrupta pode perder os últimos 200 ms de alterações.

Para começar uma festa nova, pare o servidor e renomeie `data/party.json`. Se o arquivo estiver corrompido, o servidor informa o problema e preserva o arquivo para recuperação.

Em Docker, monte um volume gravável em `/app/data`. Em hospedagens com armazenamento efêmero, configure `DATA_DIR` em um volume persistente para sobreviver a recriações da instância. O `render.yaml` não provisiona um volume. Execute apenas uma instância: o estado ativo e as sessões estão em memória.

## Regras e limites

- Até 200 participantes, 100 músicas na fila e 10 pedidos pendentes por pessoa.
- Rodadas de até duas músicas por pessoa quando outras pessoas também têm pedidos.
- Votos somente no modo Desafio, uma vez por música, sem voto na própria música.
- Veto por maioria dos votantes elegíveis; com duas pessoas, um dislike pode vetar.
- Likes dão 10 pontos ao autor; dislikes retiram 5; veto retira mais 15. Aprovação de pelo menos 70% dos votantes dá bônus de 20 ao finalizar. O votante ganha 2 pontos, exceto quando penalizado como ranzinza.
- Extração limitada a dois processos simultâneos, com cache e prazo de execução. O player tenta recuperar uma falha duas vezes e depois orienta pular a faixa.

## Desenvolvimento

```powershell
npm test
```

Os testes usam HTTP e WebSocket locais e simulam a extração de mídia, sem acessar YouTube ou abrir túneis. Cobrem permissões, payloads inválidos, identidade, votação, transferência do player, recuperação da festa, fila e cache.

- `server.js`: aplicação HTTP, eventos e regras da festa.
- `lib/security.js`: validação, sessões e limites.
- `lib/media.js`: extração e proxy de mídia.
- `lib/catalog.js`: busca nos catálogos.
- `lib/queue.js`: alternância da fila.
- `lib/persistence.js`: gravação e recuperação.
- `public/`: HTML, CSS e JavaScript separados para celular e telão, com helpers em `common.js`.

A disponibilidade de músicas depende dos serviços externos e deve ser verificada no ambiente de hospedagem. Os testes locais não validam áudio real, Chromecast ou AirPlay.

## Áudio do computador com controles no Render

A imagem Docker inclui o provedor de PO tokens bgutil 2.0.0 e seu plugin. O processo auxiliar escuta somente em `127.0.0.1:4416`, sem porta pública ou cookies de conta. O início aguarda a disponibilidade desse processo. Use `YTDLP_CLIENT=mweb` para testar esse caminho; a validação não garante acesso quando o YouTube bloqueia o endereço da hospedagem. Com `MEDIA_ORIGIN` definido, o áudio continua vindo da origem externa.

Quando o YouTube recusa as solicitações do servidor de nuvem, execute o Jukebox no computador da festa e configure `MEDIA_ORIGIN` no Render com o endereço HTTPS do túnel desse computador. Os convidados continuam no endereço do Render; o serviço encaminha somente a mídia e preserva as requisições parciais de áudio e vídeo.

O computador e o Jukebox precisam permanecer ligados e conectados durante a festa. O túnel temporário muda quando o servidor local reinicia: nesse caso, atualize `MEDIA_ORIGIN` no Render com o novo endereço exibido no terminal. Não configure `MEDIA_ORIGIN` no computador que extrai a mídia, nem aponte o Render para ele mesmo.
