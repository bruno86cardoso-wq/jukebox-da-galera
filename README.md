# Jukebox da Galera

Jukebox colaborativa: convidados pedem músicas pelo celular, enquanto um anfitrião reproduz no telão ou em um celular conectado à caixa de som. O modo Desafio inclui votação, munição de dislikes e ranking.

## Executar

Requer Node.js 22 ou superior (Docker usa Node 24).

```powershell
npm ci
npm start
```

Abra `http://localhost:3456/tv` no aparelho que vai tocar. O telão cria uma **festa** com um código curto (ex.: `K7PQ`) e vira o anfitrião dela. Os convidados entram pelo QR Code, que já leva o código, e só escolhem um apelido. Quem não tiver o QR digita o código na tela inicial do celular.

Também dá para criar a festa direto no celular (**Criar uma festa neste celular**) e usar o próprio celular ou uma JBL como som.

## Festas separadas

- Cada festa tem fila, votos, ranking e conquistas próprios. Várias festas podem rodar no mesmo servidor ao mesmo tempo sem se misturar.
- O código da festa funciona como uma senha leve: sem ele ninguém entra, mas ele vai embutido no QR Code, então ninguém precisa digitar nada.
- Quem cria a festa recebe uma chave de anfitrião, guardada só naquele navegador. Em **⚙️ Festa**, o telão mostra um QR do anfitrião para você controlar pelo seu celular. Não mostre esse QR para a galera.
- **Galera pode pular e pausar** vem ligado. O anfitrião pode desligar: aí só ele pula, volta, pausa e assume o som. Modo, tema, número de pessoas e resumo são sempre só do anfitrião. Cada convidado pode remover os próprios pedidos.
- Ao reabrir `/tv`, o telão volta para a última festa que criou. **Começar uma festa nova** gera outro código.
- Festas sem ninguém conectado são apagadas após 12 horas sem atividade.

## Recursos da festa

- **Dedicatória:** antes de pedir, escreva uma mensagem (até 60 caracteres). Ela aparece no telão quando a música toca; no Desafio, o autor só aparece depois da revelação.
- **Rodada temática:** o anfitrião escolhe um tema (Anos 2000, Só funk, Música de corno…). Todos veem o tema, e no Desafio cada música aprovada dentro do tema vale +5.
- **Conquistas:** Abriu a Pista, Maratonista, Hitmaker, Unanimidade, Sniper, Coração Mole, Ranzinza Oficial, Alvo de Tomate, Romântico, No Clima e Animador. Aparecem no telão, no celular de quem ganhou e no ranking.
- **Resumo da festa:** hino da noite, DJ da festa, mais vetado, maior ranzinza, coração mole, dedicatórias, temas e conquistas. O anfitrião mostra no telão e em todos os celulares; qualquer um vê pelo botão 📊.
- **Telão vivo:** o fundo acompanha a cor da capa da música, as reações mostram o nome de quem reagiu, e muitas reações juntas viram uma chuva de emojis.
- **Mistério de verdade:** no Desafio, o servidor não envia quem pediu, nem pelo placar ou pelas conquistas, até os 30 segundos acabarem. A contagem roda no próprio aparelho, sem mensagens a cada segundo.

Somente o aparelho ativo controla os eventos de reprodução. Ao transferir a reprodução, o anterior para. Se a internet cair, a música continua e o aparelho reassume o som sozinho quando a conexão voltar; se um vídeo não puder tocar, o app pula para a próxima. O navegador pode exigir um toque em **Continuar** para liberar som.

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
| `PUBLIC_URL` | URL pública para o QR Code. Render e Railway também são detectados. |
| `DISABLE_TUNNEL` | `1` desativa o túnel automático. |
| `DATA_DIR` | Diretório persistente; padrão `./data`. |
| `MEDIA_ORIGIN` | Origem HTTPS de outro servidor Jukebox que fornecerá o áudio, por exemplo o túnel do computador da festa. Sem essa variável, extrai a mídia no próprio servidor. |
| `YTDLP_CLIENT` | Cliente do extrator; `mweb` habilita a tentativa com validação de origem. Depende da disponibilidade no provedor. |
| `YTDLP_PLUGIN_DIR` | Diretório de plugins do extrator; configurado pela imagem Docker. |
| `MEDIA_DIAGNOSTICS_VIDEO` | ID opcional de vídeo para testar extração nativa no início, mesmo quando há `MEDIA_ORIGIN`. Remova após o diagnóstico. |
| `TRUST_PROXY_HOPS` | Número de proxies confiáveis à frente do servidor, somente se conhecido. Afeta limites HTTP por IP. |

A chave de anfitrião e a identidade de participante ficam no navegador. Limpar os dados ou usar outro endereço cria uma nova identidade; o anfitrião pode recuperar o controle pelo QR do anfitrião em outro aparelho.

## Recuperação da festa

Cada festa é salva atomicamente em `data/parties/<CÓDIGO>.json` (fila, histórico, pontuação, participantes, conquistas e a chave do anfitrião, guardada como hash), após 200 ms sem mudanças e no encerramento normal. A música atual volta pausada, do início, preservando os votos. Participantes reaparecem como desconectados até entrarem novamente. Uma interrupção abrupta pode perder os últimos 200 ms de alterações.

Para começar uma festa nova, use **⚙️ Festa → Começar uma festa nova**. Se um arquivo estiver corrompido, o servidor informa o problema, ignora aquela festa e preserva o arquivo. O antigo `data/party.json` da versão anterior não é mais usado.

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

- `server.js`: aplicação HTTP, salas de festa e eventos em tempo real.
- `lib/party.js`: regras de uma festa (fila, votos, mistério, conquistas, tema, resumo).
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
