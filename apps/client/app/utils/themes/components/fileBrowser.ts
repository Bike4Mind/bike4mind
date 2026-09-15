import { brand, gray, green, red, orange, brandAlpha, grayAlpha, greenAlpha, tealAlpha, unique } from '../colors';

export const fileBrowserTheme = {
  dark: {
    // Main backgrounds
    surface: gray[900],

    borderColor: brandAlpha[100][15],
    fileIconColor: grayAlpha[200][50],
    fileSizeColor: brandAlpha[100][50],
    lightTextColor: brandAlpha[100][75],

    buttons: {
      activeBackgroundColor: brandAlpha[800][10],
      activeHoverBackgroundColor: brandAlpha[100][25],
      hoverBackgroundColor: gray[800],

      // add files, create tag, highlighted sort option
      mainBlueBorderColor: brand[800],
    },

    list: {
      activeHoverBackgroundColor: greenAlpha[800][5],
    },

    bottomBar: {
      background: gray[900],
      borderTop: gray[800],
    },

    selectAll: {
      borderColor: gray[600],
    },

    bottomAddDisabled: {
      // opacity
      color: brandAlpha[100][35],
      backgroundColor: gray[650],
      borderColor: grayAlpha[700][50],
    },

    bottomDelete: {
      textColor: gray[0],
    },

    instructionChip: {
      dangerColor: brand[100],
    },

    statusChip: {
      backgroundColor: brandAlpha[100][5],
      textColor: brandAlpha[100][80],
      borderColor: brandAlpha[100][50],
    },

    fileGrid: {
      background: gray[850],
      hover: grayAlpha[775][50],

      checkbox: {
        checked: {
          background: greenAlpha[950][20],
          border: greenAlpha[800][50],
          hover: greenAlpha[950][40],
          icon: green[900],
        },
      },
    },

    item: {
      background: gray[850],
    },

    tagList: {
      itemBackground: 'transparent',
      inactiveItemBorderColor: brandAlpha[100][15],
      deleteIconColor: red[300],
    },

    storage: {
      backgroundColor: gray[850],
      dangerColor: red[600],
      progressColor: green[800],
      textColor: brand[100],
      textColorDanger: unique.almostBlack,
      warningColor: orange[350],
    },

    createTag: {
      secondaryText: brandAlpha[100][50],
      iconColor: brand[800],
      backgroundColor: gray[900],
      previewBorderColor: brandAlpha[100][15],
      previewBackgroundColor: gray[850],
      previewTextSecondaryColor: brandAlpha[100][50],
    },
  },
  light: {
    // Main backgrounds
    surface: gray[0],

    borderColor: gray[200],
    fileIconColor: brandAlpha[400][50],
    fileSizeColor: brandAlpha[400][50],
    lightTextColor: brandAlpha[400][50],

    buttons: {
      activeBackgroundColor: brandAlpha[800][10],
      activeHoverBackgroundColor: brandAlpha[100][25],
      hoverBackgroundColor: gray[200],

      // add files, create tag, highlighted sort option
      mainBlueBorderColor: brand[800],
    },

    // list grid
    list: {
      activeHoverBackgroundColor: greenAlpha[800][10],
    },

    bottomBar: {
      background: gray[0],
      borderTop: gray[150],
    },

    selectAll: {
      borderColor: gray[600],
    },

    bottomAddDisabled: {
      color: brandAlpha[400][35],
      backgroundColor: gray[12],
      borderColor: gray[160],
    },

    bottomDelete: {
      textColor: red[600],
    },

    instructionChip: {
      dangerColor: `var(--joy-palette-danger-500, ${red[700]})`,
    },

    statusChip: {
      backgroundColor: brandAlpha[400][8],
      textColor: brand[400],
      borderColor: brandAlpha[400][50],
    },

    fileGrid: {
      background: gray[0],
      hover: brandAlpha[100][25],

      checkbox: {
        checked: {
          background: greenAlpha[800][8],
          border: greenAlpha[800][50],
          hover: greenAlpha[800][20],
          icon: green[800],
        },
      },
    },

    item: {
      background: gray[0],
    },

    tagList: {
      itemBackground: gray[0],
      inactiveItemBorderColor: grayAlpha[150][80],
      deleteIconColor: red[700],
    },

    storage: {
      backgroundColor: grayAlpha[150][10],
      dangerColor: red[600],
      progressColor: green[800],
      textColor: brand[600],
      textColorDanger: gray[0],
      warningColor: orange[350],
    },

    createTag: {
      secondaryText: brandAlpha[400][50],
      iconColor: brandAlpha[800][50],
      backgroundColor: gray[0],
      previewBorderColor: unique.tealPreview,
      previewBackgroundColor: tealAlpha.custom[5],
      previewTextSecondaryColor: brandAlpha[400][50],
    },
  },
};
