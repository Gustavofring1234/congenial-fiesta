// Marca um objeto do .pmp instanciado por Nw4rSceneLoader (tipo, variante e índice originais).
using UnityEngine;

namespace LinuxSports.Engine
{
    /// <summary>Objeto do .pmp instanciado (tipo e variante originais).</summary>
    public sealed class PmpObject : MonoBehaviour
    {
        public int typeId;
        public int variant;
        public int index;
    }
}
