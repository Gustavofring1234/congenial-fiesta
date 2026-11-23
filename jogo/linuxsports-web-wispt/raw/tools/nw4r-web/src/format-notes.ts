/**
 * Situação de cada formato do projeto e, para o que ainda não é convertido, como o conversor
 * deveria tratá-lo. Vai para index/formats.json e aparece na aba "Inventário" do visualizador.
 *
 * Escopo: conversão de FORMATOS (binário -> padrão web). A lógica de jogo (regras, física,
 * IA, câmera, controle) fica no main.dol e não é descrita nem reimplementada aqui.
 */
export type FormatStatus = 'convertido' | 'parcial' | 'nao-convertido' | 'referencia';

export interface FormatNote {
  name: string;
  status: FormatStatus;
  what: string;
  /** saída atual na pasta web */
  output: string;
  /** como completar a conversão (vazio quando já está completa) */
  howToConvert: string;
}

export const FORMAT_NOTES: Record<string, FormatNote> = {
  '.tpl': { name: 'Textura GX (TPL)', status: 'convertido', what: 'Imagens da interface (timg/).', output: '.png + .tex.json', howToConvert: '' },
  '.brfnt': { name: 'Fonte NW4R (RFNT)', status: 'convertido', what: 'Fontes bitmap usadas pelos layouts.', output: 'atlas .png + .font.json (BMFont)', howToConvert: '' },
  '.brlyt': { name: 'Layout NW4R (RLYT)', status: 'convertido', what: 'Telas de menu e HUD: árvore de painéis, materiais, textos, janelas.', output: '.layout.json (renderizado na aba Telas)',
    howToConvert: 'Pendências de fidelidade: estágios TEV customizados (tevStageCount > 0) e molduras de janela com várias texturas são aproximados no visualizador.' },
  '.brlan': { name: 'Animação de layout (RLAN)', status: 'convertido', what: 'Animações das telas (posição, escala, cor, visibilidade, troca de textura).', output: '.anim.json', howToConvert: '' },
  '.brlpa': { name: 'Animação de layout dividida (RLPA)', status: 'convertido', what: 'Só trilhas de painel (SRT).', output: '.anim.json', howToConvert: '' },
  '.brlvi': { name: 'Animação de layout dividida (RLVI)', status: 'convertido', what: 'Só visibilidade.', output: '.anim.json', howToConvert: '' },
  '.brlmc': { name: 'Animação de layout dividida (RLMC)', status: 'convertido', what: 'Só cores de material.', output: '.anim.json', howToConvert: '' },
  '.kcl': { name: 'Colisão (KCL)', status: 'convertido', what: 'Malha de colisão dos estágios, com flag de superfície por triângulo.', output: '.glb (uma malha por flag)',
    howToConvert: 'A octree de aceleração não é exportada; um motor de física web (ex.: Rapier, cannon-es) reconstrói a sua a partir do .glb.' },
  '.brres': { name: 'Recursos 3D NW4R (BRRES)', status: 'parcial', what: 'Modelos (MDL0), texturas (TEX0) e animações 3D.', output: 'modelos em .glb (pose de repouso) + .model.json',
    howToConvert: [
      'CHR0 (esqueleto): exportar o MDL0 com ossos e pesos como skin glTF; converter cada trilha de osso (escala/rotação/translação, chaves Hermite) em canais de animação glTF.',
      'SRT0 (UV): trilhas de translação/rotação/escala de textura -> KHR_texture_transform animado (KHR_animation_pointer).',
      'PAT0 (troca de textura): sequências de quadros -> lista de texturas por material + chaves em extras.',
      'CLR0 (cor de material) -> KHR_animation_pointer sobre baseColorFactor/emissive.',
      'VIS0 (visibilidade) -> KHR_node_visibility (ou escala 0).',
      'SHP0 (morph) -> morph targets glTF com pesos animados.',
      'SCN0 (câmeras e luzes de cena) -> câmeras glTF e KHR_lights_punctual animados.',
      'Materiais: hoje só a 1ª camada de textura e o 1º UV; combinar lightmaps/reflexos exige um shader próprio (ShaderMaterial).',
    ].join(' ') },
  '.pmp': { name: 'Posicionamento de objetos (PMPF)', status: 'parcial', what: 'Objetos dos cursos de golfe: tipo, posição, escala e eixos.', output: 'objects[] em .scene.json',
    howToConvert: 'Falta a tabela id de tipo -> nome de modelo, que fica no executável (rotina de carga do mapa). Com ela, cada objeto recebe o .glb correspondente.' },
  '.plight': { name: 'Luzes de cena (LGHT)', status: 'nao-convertido', what: 'Cabeçalho 0x48 + 16 slots LOBJ de 0x50 bytes.', output: 'binário em raw/, ligado à cena',
    howToConvert: 'Decodificar cada LOBJ (tipo, cor RGBA, posição/direção, atenuação) e emitir KHR_lights_punctual ou um .lights.json lido pelo visualizador.' },
  '.plmap': { name: 'Mapa de luz (LMAP)', status: 'nao-convertido', what: 'Lista de lightmaps (lm_0, lm_1) aplicados ao cenário.', output: 'binário em raw/, ligado aos .bti',
    howToConvert: 'Converter os .bti citados para PNG e aplicá-los como lightMap no 2º conjunto de UV dos materiais do cenário.' },
  '.pblm': { name: 'Bloom (PBLM)', status: 'nao-convertido', what: '164 bytes com parâmetros de pós-processamento.', output: 'binário em raw/',
    howToConvert: 'Mapear os floats (limiar, intensidade, raio) para um UnrealBloomPass/efeito equivalente e salvar em .postfx.json.' },
  '.pmmisc': { name: 'Parâmetros de material (MMSC)', status: 'nao-convertido', what: 'Entradas nomeadas como M_Bunker_v, M_Green_v, M_Sky_v.', output: 'binário em raw/',
    howToConvert: 'Confirmar o layout das entradas e associar pelo nome aos materiais dos .glb do curso.' },
  '.bti': { name: 'Textura J3D (BTI)', status: 'nao-convertido', what: 'Textura GX com cabeçalho de 0x20 bytes (lightmaps).', output: 'binário em raw/',
    howToConvert: 'Ler formato/largura/altura/offset do cabeçalho e decodificar com o mesmo codec GX dos .tpl -> PNG.' },
  '.breff': { name: 'Efeitos de partícula (REFF)', status: 'nao-convertido', what: 'Emissores nomeados (380 no total) e parâmetros.', output: 'binário em raw/, ligado ao .breft',
    howToConvert: 'Decodificar os parâmetros de cada emissor (taxa, vida, velocidade, cor, tamanho, textura) para um .particles.json consumido por um sistema de partículas em three.js.' },
  '.breft': { name: 'Texturas de efeito (REFT)', status: 'nao-convertido', what: 'Texturas GX nomeadas usadas pelos .breff.', output: 'binário em raw/',
    howToConvert: 'Ler a tabela de nomes e os cabeçalhos GX de cada textura e decodificar para PNG com o codec dos .tpl.' },
  '.rcd': { name: 'Registro de Mii (RCD)', status: 'nao-convertido', what: '74 bytes por personagem; nome UTF-16BE em 0x02.', output: 'binário em raw/',
    howToConvert: 'Decodificar os campos (nome, cor, traços faciais) para .mii.json. Renderizar o rosto exige os recursos de face do sistema, que não estão no projeto.' },
  '.bmg': { name: 'Mensagens (BMG)', status: 'parcial', what: 'Textos do jogo (INF1/DAT1/MID1).', output: 'binário em raw/ + TSV em docs/textos',
    howToConvert: 'Exportar INF1+DAT1 como .messages.json indexado pelo ID de MID1, para os textos dinâmicos dos layouts.' },
  '.bwav': { name: 'Áudio cru (BWAV)', status: 'parcial', what: 'PCM16 big-endian sem cabeçalho.', output: 'binário em raw/ + WAV em assets/audio/decoded',
    howToConvert: 'Confirmar a taxa de amostragem (o WAV usa 32 kHz por suposição) e reexportar em OGG/Opus.' },
  '.brsar': { name: 'Arquivo de som (BRSAR)', status: 'parcial', what: 'Só HomeButtonSe.brsar (27 símbolos, sem ondas).', output: 'binário em raw/',
    howToConvert: 'Os bancos rp_*_sound.brsar citados pelo código não estão no projeto; sem eles não há sons a converter.' },
  '.wav': { name: 'Áudio decodificado', status: 'convertido', what: 'WAVs gerados dos .bwav.', output: 'raw/ (tocável no navegador)', howToConvert: '' },
  '.bin': { name: 'Tabelas de dados', status: 'nao-convertido', what: 'cpuData, TrialData, GateChallengeData, BowExcelGlobal.', output: 'binário em raw/',
    howToConvert: 'O layout das estruturas só pode ser confirmado pelo código que as lê; depois, exportar como JSON.' },
  '.dol': { name: 'Executável do Wii (DOL)', status: 'referencia', what: 'Código PowerPC com toda a lógica do jogo.', output: 'raw/main.dol (sem alteração)',
    howToConvert: 'Não é convertido. Para jogar, use a imagem do disco original no Dolphin (perfil em config/dolphin).' },
  '.arc': { name: 'Arquivo U8 (ARC)', status: 'convertido', what: 'Contêiner; o conteúdo já está extraído na pasta .arc.d ao lado.', output: 'conteúdo convertido + original em raw/', howToConvert: '' },
  '.glb': { name: 'Modelo glTF', status: 'convertido', what: 'Modelos gerados dos .brres por scripts/brres2glb.py.', output: 'models/**.glb', howToConvert: '' },
  '.png': { name: 'Textura renomeada', status: 'referencia', what: 'Cópias com nome semântico (assets/textures).', output: 'raw/assets/textures, ligadas à textura/modelo de origem', howToConvert: '' },
  '.c': { name: 'Código decompilado', status: 'referencia', what: 'Saída do Ghidra para leitura; não compila.', output: 'raw/', howToConvert: '' },
  '.tsv': { name: 'Tabelas de análise/textos', status: 'referencia', what: 'Funções, nomes, strings e mensagens exportadas.', output: 'raw/', howToConvert: '' },
};

export function noteFor(ext: string): FormatNote {
  return FORMAT_NOTES[ext] ?? { name: ext || '(sem extensão)', status: 'referencia', what: 'Arquivo de apoio do projeto (documentação, script ou configuração).', output: 'raw/', howToConvert: '' };
}
