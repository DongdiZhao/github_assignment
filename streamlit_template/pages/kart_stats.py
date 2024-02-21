import streamlit as st
import pandas as pd

st.markdown("# Kart Configurations 🏎️")
st.sidebar.markdown("# Kart Configurations 🏎️")

st.write("What Kart Configuration is Best?")

df_kart = pd.read_csv('streamlit_template/data/kart_stats.csv')

st.title('Kart Stats Dashboard')
st.header('Kart Statistics Overview')
st.dataframe(df_kart)

st.header('Simplified Kart Stats with Highlighted Extremes')
columns_to_display = ['Body', 'Weight', 'Acceleration', 'Ground Handling', 'Mini-Turbo']
df_kart_simplified = df_kart[columns_to_display]
st.dataframe(df_kart_simplified.style.highlight_max(color='lightgreen').highlight_min(color='red'))

st.header('Weight vs Acceleration Comparison')
st.bar_chart(df_kart[['Weight', 'Acceleration']])

st.header('Handling and MiniTurbo Over Karts')
st.line_chart(df_kart[['Ground Handling', 'Mini-Turbo']])

st.header('Detailed Stats for Selected Kart')
chosen_kart = st.selectbox('Pick a Kart', df_kart['Body'])
df_single_kart = df_kart.loc[df_kart['Body'] == chosen_kart]
df_single_kart = df_single_kart.drop(columns=['Body'])
df_unp_kart = df_single_kart.set_index([df_single_kart.index]).unstack().rename_axis(['Category', 'Index']).reset_index(name='Strength').drop(columns=['Index'])
st.bar_chart(df_unp_kart, x='Category', y='Strength', use_container_width=True)